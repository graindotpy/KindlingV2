import { getAppConfig } from "@/lib/config";
import {
  createBookRequestsRepository,
  type CreateBookRequestInput,
} from "@/lib/db/repositories/book-requests";
import { createUsersRepository } from "@/lib/db/repositories/users";
import {
  createReadarrService,
  pickBestCoverUrl,
  pickPreferredEditionId,
  ReadarrApiError,
  type ReadarrService,
} from "@/lib/readarr/service";
import type { ReadarrLookupBook } from "@/lib/readarr/types";
import {
  buildFingerprintFromLookupBook,
  extractYear,
} from "@/lib/requests/fingerprint";
import {
  BOOK_REQUEST_STATUS_LABELS,
  blocksNewRequest,
  isActiveStatus,
  mapReadarrBookToFriendlyStatus,
} from "@/lib/requests/status";
import type {
  BookRequestRecord,
  SearchResultAvailability,
  SearchResultItem,
} from "@/lib/requests/types";

type RequestsRepository = ReturnType<typeof createBookRequestsRepository>;
type UsersRepository = ReturnType<typeof createUsersRepository>;

type RequestServiceDependencies = {
  requestsRepo: RequestsRepository;
  usersRepo: UsersRepository;
  readarr: ReadarrService;
  now: () => string;
  syncIntervalMs: number;
};

function getAuthorName(result: ReadarrLookupBook) {
  return result.author?.authorName?.trim() || null;
}

function hasSearchResultIdentity(result: ReadarrLookupBook) {
  return Boolean(result.title?.trim() && getAuthorName(result) && result.foreignBookId?.trim());
}

function buildAvailabilityCopy(
  availability: SearchResultAvailability,
  request: BookRequestRecord | null,
) {
  switch (availability) {
    case "requested-by-you":
      return {
        label: "Already in My Books",
        description: request
          ? `You already asked for this and it is ${BOOK_REQUEST_STATUS_LABELS[request.status].toLowerCase()}.`
          : "You already asked for this book.",
      };
    case "already-available":
      return {
        label: "Already ready",
        description: "This book already exists in the family collection.",
      };
    case "already-requested":
      return {
        label: "Already requested",
        description: request?.userName
          ? `${request.userName} already asked for this one.`
          : "Someone in the house already asked for this one.",
      };
    default:
      return {
        label: "Ready to request",
        description: "Ask Kindling to send this to Readarr.",
      };
  }
}

function getFriendlyErrorMessage(error: unknown) {
  if (error instanceof ReadarrApiError) {
    if (error.status === 503) {
      return "Readarr is not configured yet on this computer.";
    }

    if (error.status >= 500) {
      return "Readarr had trouble handling that request. Your request was still saved here.";
    }

    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something unexpected went wrong, but your request is still saved here.";
}

function getSearchAvailability(
  result: ReadarrLookupBook,
  requestedByUser: BookRequestRecord | null,
  existingSystemRequest: BookRequestRecord | null,
): SearchResultAvailability {
  if (requestedByUser && blocksNewRequest(requestedByUser.status)) {
    return "requested-by-you";
  }

  if (
    (result.statistics?.bookFileCount ?? 0) > 0 ||
    existingSystemRequest?.status === "available"
  ) {
    return "already-available";
  }

  if (existingSystemRequest && blocksNewRequest(existingSystemRequest.status)) {
    return "already-requested";
  }

  return "requestable";
}

function buildDraftRequest(
  userId: number,
  selection: ReadarrLookupBook,
  timestamp: string,
): CreateBookRequestInput {
  return {
    userId,
    requestFingerprint: buildFingerprintFromLookupBook(selection),
    requestedTitle: selection.title,
    requestedAuthor: selection.author.authorName,
    requestedYear: extractYear(selection.releaseDate),
    requestedAt: timestamp,
    status: "requested",
    statusMessage: "Saving your request.",
    foreignAuthorId: selection.author.foreignAuthorId ?? null,
    foreignBookId: selection.foreignBookId ?? null,
    foreignEditionId: selection.foreignEditionId ?? null,
    readarrAuthorId: selection.author.id ?? null,
    readarrBookId: selection.id ?? null,
    readarrEditionId: pickPreferredEditionId(selection),
    coverUrl: pickBestCoverUrl(selection),
    notes: null,
    lastSyncedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function buildDraftRequestPatch(draft: CreateBookRequestInput) {
  return {
    requestFingerprint: draft.requestFingerprint,
    requestedTitle: draft.requestedTitle,
    requestedAuthor: draft.requestedAuthor,
    requestedYear: draft.requestedYear,
    requestedAt: draft.requestedAt,
    status: draft.status,
    statusMessage: draft.statusMessage,
    foreignAuthorId: draft.foreignAuthorId,
    foreignBookId: draft.foreignBookId,
    foreignEditionId: draft.foreignEditionId,
    readarrAuthorId: draft.readarrAuthorId,
    readarrBookId: draft.readarrBookId,
    readarrEditionId: draft.readarrEditionId,
    coverUrl: draft.coverUrl,
    notes: draft.notes,
    lastSyncedAt: draft.lastSyncedAt,
    updatedAt: draft.updatedAt,
  };
}

export function createRequestService(partialDeps: Partial<RequestServiceDependencies> = {}) {
  const config = getAppConfig();
  const deps: RequestServiceDependencies = {
    requestsRepo: partialDeps.requestsRepo ?? createBookRequestsRepository(),
    usersRepo: partialDeps.usersRepo ?? createUsersRepository(),
    readarr: partialDeps.readarr ?? createReadarrService(),
    now: partialDeps.now ?? (() => new Date().toISOString()),
    syncIntervalMs: partialDeps.syncIntervalMs ?? config.syncIntervalMs,
  };

  async function syncSingleRequest(record: BookRequestRecord) {
    if (!record.readarrBookId || !deps.readarr.isConfigured()) {
      return record;
    }

    try {
      const { book, queueItems } = await deps.readarr.getBookStatus(record.readarrBookId);
      const mapped = mapReadarrBookToFriendlyStatus(book, queueItems, record.status);

      return deps.requestsRepo.update(record.id, {
        status: mapped.status,
        statusMessage: mapped.message,
        coverUrl: pickBestCoverUrl(book) ?? record.coverUrl,
        readarrAuthorId: book.author.id ?? record.readarrAuthorId,
        readarrBookId: book.id ?? record.readarrBookId,
        readarrEditionId: pickPreferredEditionId(book) ?? record.readarrEditionId,
        lastSyncedAt: deps.now(),
      });
    } catch (error) {
      if (error instanceof ReadarrApiError && error.status === 404) {
        return deps.requestsRepo.update(record.id, {
          status: "failed",
          statusMessage: "Kindling could not find this book in Readarr anymore.",
          lastSyncedAt: deps.now(),
        });
      }

      return record;
    }
  }

  async function syncStaleRequests(records: BookRequestRecord[]) {
    const staleBefore = Date.now() - deps.syncIntervalMs;

    for (const request of records) {
      const lastTouched = new Date(request.lastSyncedAt ?? request.updatedAt).getTime();
      if (
        request.readarrBookId &&
        isActiveStatus(request.status) &&
        Number.isFinite(lastTouched) &&
        lastTouched < staleBefore
      ) {
        await syncSingleRequest(request);
      }
    }
  }

  return {
    async listRequestsForUser(userId: number) {
      const user = deps.usersRepo.getById(userId);
      if (!user) {
        throw new Error("We could not find that family member.");
      }

      const existing = deps.requestsRepo.listByUser(userId);
      await syncStaleRequests(existing);

      return deps.requestsRepo.listByUser(userId);
    },

    async listAllRequests() {
      const existing = deps.requestsRepo.listAll();
      await syncStaleRequests(existing);
      return deps.requestsRepo.listAll();
    },

    async searchBooksForUser(userId: number, query: string) {
      const user = deps.usersRepo.getById(userId);
      if (!user) {
        throw new Error("We could not find that family member.");
      }

      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        return [] as SearchResultItem[];
      }

      const results = (await deps.readarr.searchBooks(trimmedQuery)).filter(hasSearchResultIdentity);
      const fingerprints = results.map((result) => buildFingerprintFromLookupBook(result));
      const userRequests = deps.requestsRepo.findByFingerprintsForUser(userId, fingerprints);
      const systemRequests = deps.requestsRepo.findLatestByFingerprints(fingerprints);

      const requestedByUserByFingerprint = new Map(
        userRequests.map((request) => [request.requestFingerprint, request]),
      );
      const systemRequestsByFingerprint = new Map<string, BookRequestRecord>();

      for (const request of systemRequests) {
        const current = systemRequestsByFingerprint.get(request.requestFingerprint);
        if (!current) {
          systemRequestsByFingerprint.set(request.requestFingerprint, request);
          continue;
        }

        if (!blocksNewRequest(current.status) && blocksNewRequest(request.status)) {
          systemRequestsByFingerprint.set(request.requestFingerprint, request);
        }
      }

      return results.map((result) => {
        const fingerprint = buildFingerprintFromLookupBook(result);
        const requestedByUser = requestedByUserByFingerprint.get(fingerprint) ?? null;
        const existingSystemRequest = systemRequestsByFingerprint.get(fingerprint) ?? null;
        const availability = getSearchAvailability(
          result,
          requestedByUser,
          existingSystemRequest,
        );
        const copy = buildAvailabilityCopy(
          availability,
          requestedByUser ?? existingSystemRequest,
        );

        return {
          fingerprint,
          title: result.title,
          author: getAuthorName(result) ?? "Unknown author",
          year: extractYear(result.releaseDate),
          coverUrl: pickBestCoverUrl(result),
          availability,
          availabilityLabel: copy.label,
          availabilityDescription: copy.description,
          request: requestedByUser ?? existingSystemRequest,
          source: result,
        } satisfies SearchResultItem;
      });
    },

    async createRequest(userId: number, selection: ReadarrLookupBook) {
      const user = deps.usersRepo.getById(userId);
      if (!user) {
        throw new Error("We could not find that family member.");
      }

      const fingerprint = buildFingerprintFromLookupBook(selection);
      const existing = deps.requestsRepo.findByUserAndFingerprint(userId, fingerprint);
      if (existing && blocksNewRequest(existing.status)) {
        return existing;
      }

      const timestamp = deps.now();
      const draft = buildDraftRequest(userId, selection, timestamp);
      const created = existing
        ? deps.requestsRepo.update(existing.id, buildDraftRequestPatch(draft))
        : deps.requestsRepo.create(draft);

      if (!created) {
        throw new Error("Kindling could not save this request.");
      }

      if (!deps.readarr.isConfigured()) {
        return deps.requestsRepo.update(created.id, {
          status: "failed",
          statusMessage:
            "Readarr is not configured yet, so this request was saved locally for later.",
          notes: "Readarr configuration is missing.",
          updatedAt: deps.now(),
        });
      }

      try {
        const book = await deps.readarr.addBookForRequest(selection);

        if (!book.id) {
          throw new Error("Readarr returned the book without an id.");
        }

        await deps.readarr.monitorRequestedBook(book.id);

        let fallbackStatus: {
          status: "requested" | "searching";
          message: string;
        } = {
          status: "requested" as const,
          message: "Your request has been saved.",
        };

        try {
          await deps.readarr.triggerBookSearch(book.id);
          fallbackStatus = {
            status: "searching" as const,
            message: "Readarr is searching for this book now.",
          };
        } catch {
          fallbackStatus = {
            status: "requested" as const,
            message: "Saved to Readarr, but automatic searching could not be started.",
          };
        }

        try {
          const { book: liveBook, queueItems } = await deps.readarr.getBookStatus(book.id);
          const mapped = mapReadarrBookToFriendlyStatus(
            liveBook,
            queueItems,
            fallbackStatus.status,
          );

          return deps.requestsRepo.update(created.id, {
            status: mapped.status,
            statusMessage: mapped.message,
            foreignAuthorId: liveBook.author.foreignAuthorId ?? created.foreignAuthorId,
            foreignBookId: liveBook.foreignBookId ?? created.foreignBookId,
            foreignEditionId: liveBook.foreignEditionId ?? created.foreignEditionId,
            readarrAuthorId: liveBook.author.id ?? created.readarrAuthorId,
            readarrBookId: liveBook.id ?? created.readarrBookId,
            readarrEditionId: pickPreferredEditionId(liveBook) ?? created.readarrEditionId,
            coverUrl: pickBestCoverUrl(liveBook) ?? created.coverUrl,
            lastSyncedAt: deps.now(),
            updatedAt: deps.now(),
          });
        } catch {
          return deps.requestsRepo.update(created.id, {
            status: fallbackStatus.status,
            statusMessage: fallbackStatus.message,
            foreignAuthorId: book.author.foreignAuthorId ?? created.foreignAuthorId,
            foreignBookId: book.foreignBookId ?? created.foreignBookId,
            foreignEditionId: book.foreignEditionId ?? created.foreignEditionId,
            readarrAuthorId: book.author.id ?? created.readarrAuthorId,
            readarrBookId: book.id ?? created.readarrBookId,
            readarrEditionId: pickPreferredEditionId(book) ?? created.readarrEditionId,
            coverUrl: pickBestCoverUrl(book) ?? created.coverUrl,
            updatedAt: deps.now(),
          });
        }
      } catch (error) {
        return deps.requestsRepo.update(created.id, {
          status: "failed",
          statusMessage: getFriendlyErrorMessage(error),
          notes: "The request intent was saved locally even though Readarr could not finish it.",
          updatedAt: deps.now(),
        });
      }
    },

    async syncRequest(requestId: number) {
      const request = deps.requestsRepo.findById(requestId);
      if (!request) {
        throw new Error("We could not find that request.");
      }

      return syncSingleRequest(request);
    },
  };
}
