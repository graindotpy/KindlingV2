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
  BookRequestFormat,
  BookRequestRecord,
  SearchResultAvailability,
  SearchResultItem,
  SearchResultRequestAction,
} from "@/lib/requests/types";

const REQUEST_FORMATS: BookRequestFormat[] = ["ebook", "audiobook"];

type RequestsRepository = ReturnType<typeof createBookRequestsRepository>;
type UsersRepository = ReturnType<typeof createUsersRepository>;
type ReadarrServices = Record<BookRequestFormat, ReadarrService>;

type RequestServiceDependencies = {
  requestsRepo: RequestsRepository;
  usersRepo: UsersRepository;
  readarr: ReadarrServices;
  now: () => string;
  syncIntervalMs: number;
};

type PartialRequestServiceDependencies = Omit<
  Partial<RequestServiceDependencies>,
  "readarr"
> & {
  readarr?: Partial<ReadarrServices>;
};

type SearchActionUnavailableReason =
  | "not-configured"
  | "search-failed"
  | "not-found";

function getRequestLookupKey(format: BookRequestFormat, fingerprint: string) {
  return `${format}:${fingerprint}`;
}

function getFormatNoun(format: BookRequestFormat) {
  return format === "audiobook" ? "audiobook" : "book";
}

function getAuthorName(result: ReadarrLookupBook) {
  return result.author?.authorName?.trim() || null;
}

function hasSearchResultIdentity(result: ReadarrLookupBook) {
  return Boolean(result.title?.trim() && getAuthorName(result) && result.foreignBookId?.trim());
}

function buildAvailabilityCopy(
  format: BookRequestFormat,
  availability: SearchResultAvailability,
  request: BookRequestRecord | null,
) {
  const itemLabel = getFormatNoun(format);

  switch (availability) {
    case "requested-by-you":
      return {
        label: "Already in My List",
        description: request
          ? `You already asked for this ${itemLabel} and it is ${BOOK_REQUEST_STATUS_LABELS[request.status].toLowerCase()}.`
          : `You already asked for this ${itemLabel}.`,
      };
    case "already-available":
      return {
        label: "Already ready",
        description:
          format === "audiobook"
            ? "This audiobook already exists in the household library."
            : "This book already exists in the family collection.",
      };
    case "already-requested":
      return {
        label: "Already requested",
        description: request?.userName
          ? `${request.userName} already asked for this ${itemLabel}.`
          : `Someone in the house already asked for this ${itemLabel}.`,
      };
    case "unavailable":
      return {
        label: "Unavailable",
        description:
          format === "audiobook"
            ? "This audiobook is unavailable right now."
            : "This book is unavailable right now.",
      };
    default:
      return {
        label: "Ready to request",
        description:
          format === "audiobook"
            ? "Send this to the audiobook Readarr."
            : "Ask Kindling to send this to Readarr.",
      };
  }
}

function getFriendlyErrorMessage(error: unknown, format: BookRequestFormat) {
  if (error instanceof ReadarrApiError) {
    if (error.status === 503) {
      return format === "audiobook"
        ? "The audiobook Readarr is not configured yet on this computer."
        : "Readarr is not configured yet on this computer.";
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

function buildUnavailableCopy(
  format: BookRequestFormat,
  reason: SearchActionUnavailableReason,
) {
  if (reason === "not-configured") {
    return {
      label: "Not configured",
      description:
        format === "audiobook"
          ? "Configure the audiobook Readarr to request audiobooks."
          : "Configure Readarr to request EPUB books.",
    };
  }

  if (reason === "search-failed") {
    return {
      label: "Search unavailable",
      description:
        format === "audiobook"
          ? "Kindling could not search the audiobook Readarr right now."
          : "Kindling could not search Readarr right now.",
    };
  }

  return {
    label: "No match found",
    description:
      format === "audiobook"
        ? "This title did not appear in the audiobook Readarr search."
        : "This title did not appear in the EPUB Readarr search.",
  };
}

function getExistingRequestAvailability(
  requestedByUser: BookRequestRecord | null,
  existingSystemRequest: BookRequestRecord | null,
): Exclude<SearchResultAvailability, "requestable" | "unavailable"> | null {
  if (requestedByUser && blocksNewRequest(requestedByUser.status)) {
    return "requested-by-you";
  }

  if (existingSystemRequest?.status === "available") {
    return "already-available";
  }

  if (existingSystemRequest && blocksNewRequest(existingSystemRequest.status)) {
    return "already-requested";
  }

  return null;
}

function getSearchAvailability(
  result: ReadarrLookupBook,
  requestedByUser: BookRequestRecord | null,
  existingSystemRequest: BookRequestRecord | null,
): SearchResultAvailability {
  const existingAvailability = getExistingRequestAvailability(
    requestedByUser,
    existingSystemRequest,
  );

  if (existingAvailability) {
    return existingAvailability;
  }

  if ((result.statistics?.bookFileCount ?? 0) > 0) {
    return "already-available";
  }

  return "requestable";
}

function buildDraftRequest(
  userId: number,
  requestFormat: BookRequestFormat,
  selection: ReadarrLookupBook,
  timestamp: string,
): CreateBookRequestInput {
  return {
    userId,
    requestFormat,
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
    matchedFilePath: null,
    matchedAt: null,
    lastDeliveryAt: null,
    lastDeliveryRecipient: null,
    lastDeliveryTrigger: null,
    lastDeliveryMessage: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function buildDraftRequestPatch(draft: CreateBookRequestInput) {
  return {
    requestFormat: draft.requestFormat,
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

function buildDeleteRequestStatusMessage(options: {
  deletedExistingFile: boolean;
  hadReadarrBook: boolean;
  readarrBookMissing: boolean;
}) {
  if (options.readarrBookMissing) {
    return "Readarr no longer has this book, so the request was reset to Not Monitored.";
  }

  if (options.deletedExistingFile) {
    return "Readarr deleted the existing file and stopped monitoring this book.";
  }

  if (options.hadReadarrBook) {
    return "Readarr stopped monitoring this book.";
  }

  return "This request was reset to Not Monitored.";
}

function buildRequestLookup(records: BookRequestRecord[]) {
  const lookup = new Map<string, BookRequestRecord>();

  for (const request of records) {
    const key = getRequestLookupKey(request.requestFormat, request.requestFingerprint);
    const current = lookup.get(key);

    if (!current) {
      lookup.set(key, request);
      continue;
    }

    if (!blocksNewRequest(current.status) && blocksNewRequest(request.status)) {
      lookup.set(key, request);
      continue;
    }

    if (new Date(request.updatedAt).getTime() >= new Date(current.updatedAt).getTime()) {
      lookup.set(key, request);
    }
  }

  return lookup;
}

function isVisibleRequest(record: BookRequestRecord) {
  return record.status !== "not-monitored";
}

function buildSearchAction(
  format: BookRequestFormat,
  result: ReadarrLookupBook | null,
  requestedByUser: BookRequestRecord | null,
  existingSystemRequest: BookRequestRecord | null,
  options: {
    configured: boolean;
    searchFailed: boolean;
  },
): SearchResultRequestAction {
  const request = requestedByUser ?? existingSystemRequest;
  const existingAvailability = getExistingRequestAvailability(
    requestedByUser,
    existingSystemRequest,
  );

  if (!result) {
    if (existingAvailability) {
      const copy = buildAvailabilityCopy(format, existingAvailability, request);

      return {
        format,
        availability: existingAvailability,
        availabilityLabel: copy.label,
        availabilityDescription: copy.description,
        request,
        source: null,
      };
    }

    const unavailableReason: SearchActionUnavailableReason = !options.configured
      ? "not-configured"
      : options.searchFailed
        ? "search-failed"
        : "not-found";
    const copy = buildUnavailableCopy(format, unavailableReason);

    return {
      format,
      availability: "unavailable",
      availabilityLabel: copy.label,
      availabilityDescription: copy.description,
      request,
      source: null,
    };
  }

  const availability = getSearchAvailability(result, requestedByUser, existingSystemRequest);
  const copy = buildAvailabilityCopy(format, availability, request);

  return {
    format,
    availability,
    availabilityLabel: copy.label,
    availabilityDescription: copy.description,
    request,
    source: result,
  };
}

export function createRequestService(
  partialDeps: PartialRequestServiceDependencies = {},
) {
  const config = getAppConfig();
  const deps: RequestServiceDependencies = {
    requestsRepo: partialDeps.requestsRepo ?? createBookRequestsRepository(),
    usersRepo: partialDeps.usersRepo ?? createUsersRepository(),
    readarr: {
      ebook: partialDeps.readarr?.ebook ?? createReadarrService("ebook"),
      audiobook: partialDeps.readarr?.audiobook ?? createReadarrService("audiobook"),
    },
    now: partialDeps.now ?? (() => new Date().toISOString()),
    syncIntervalMs: partialDeps.syncIntervalMs ?? config.syncIntervalMs,
  };

  function getReadarrForFormat(format: BookRequestFormat) {
    return deps.readarr[format];
  }

  function updateRequestAsNotMonitored(
    record: BookRequestRecord,
    options: {
      message: string;
      readarrBookMissing?: boolean;
    },
  ) {
    const timestamp = deps.now();
    const updated = deps.requestsRepo.update(record.id, {
      status: "not-monitored",
      statusMessage: options.message,
      readarrBookId: options.readarrBookMissing ? null : record.readarrBookId,
      readarrEditionId: options.readarrBookMissing ? null : record.readarrEditionId,
      notes: null,
      lastSyncedAt: timestamp,
      matchedFilePath: null,
      matchedAt: null,
      lastDeliveryAt: null,
      lastDeliveryRecipient: null,
      lastDeliveryTrigger: null,
      lastDeliveryMessage: null,
      updatedAt: timestamp,
    });

    if (!updated) {
      throw new Error("Kindling could not update that request.");
    }

    return updated;
  }

  async function syncSingleRequest(record: BookRequestRecord) {
    const readarr = getReadarrForFormat(record.requestFormat);

    if (!record.readarrBookId || !readarr.isConfigured()) {
      return record;
    }

    try {
      const { book, queueItems } = await readarr.getBookStatus(record.readarrBookId);
      const mapped = mapReadarrBookToFriendlyStatus(book, queueItems, record.status);

      if (mapped.status === "not-monitored") {
        return updateRequestAsNotMonitored(record, {
          message: mapped.message,
        });
      }

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
        return updateRequestAsNotMonitored(record, {
          message: buildDeleteRequestStatusMessage({
            deletedExistingFile: false,
            hadReadarrBook: true,
            readarrBookMissing: true,
          }),
          readarrBookMissing: true,
        });
      }

      return record;
    }
  }

  async function syncStaleRequests(records: BookRequestRecord[]) {
    const staleBefore = Date.now() - deps.syncIntervalMs;

    for (const request of records) {
      const readarr = getReadarrForFormat(request.requestFormat);
      const lastTouched = new Date(request.lastSyncedAt ?? request.updatedAt).getTime();

      if (
        request.readarrBookId &&
        readarr.isConfigured() &&
        isActiveStatus(request.status) &&
        Number.isFinite(lastTouched) &&
        lastTouched < staleBefore
      ) {
        await syncSingleRequest(request);
      }
    }
  }

  async function deleteRequest(requestId: number) {
    const request = deps.requestsRepo.findById(requestId);
    if (!request) {
      throw new Error("We could not find that request.");
    }

    const readarr = getReadarrForFormat(request.requestFormat);
    const hasReadarrBook = Boolean(request.readarrBookId);

    if (hasReadarrBook && !readarr.isConfigured()) {
      throw new Error("Readarr is not configured yet, so Kindling cannot delete this request.");
    }

    let deletedExistingFile = false;
    let readarrBookMissing = false;

    if (request.readarrBookId) {
      try {
        const bookFiles = await readarr.getBookFiles(request.readarrBookId);

        for (const bookFile of bookFiles) {
          try {
            await readarr.deleteBookFile(bookFile.id);
            deletedExistingFile = true;
          } catch (error) {
            if (error instanceof ReadarrApiError && error.status === 404) {
              continue;
            }

            throw error;
          }
        }
      } catch (error) {
        if (error instanceof ReadarrApiError && error.status === 404) {
          readarrBookMissing = true;
        } else {
          throw error;
        }
      }

      if (!readarrBookMissing) {
        try {
          await readarr.unmonitorRequestedBook(request.readarrBookId);
        } catch (error) {
          if (error instanceof ReadarrApiError && error.status === 404) {
            readarrBookMissing = true;
          } else {
            throw error;
          }
        }
      }
    }

    return updateRequestAsNotMonitored(request, {
      message: buildDeleteRequestStatusMessage({
        deletedExistingFile,
        hadReadarrBook: hasReadarrBook,
        readarrBookMissing,
      }),
      readarrBookMissing,
    });
  }

  return {
    async listRequestsForUser(userId: number) {
      const user = deps.usersRepo.getById(userId);
      if (!user) {
        throw new Error("We could not find that family member.");
      }

      const existing = deps.requestsRepo.listByUser(userId);
      await syncStaleRequests(existing);

      return deps.requestsRepo.listByUser(userId).filter(isVisibleRequest);
    },

    async listAllRequests() {
      const existing = deps.requestsRepo.listAll();
      await syncStaleRequests(existing);
      return deps.requestsRepo.listAll().filter(isVisibleRequest);
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

      if (!REQUEST_FORMATS.some((format) => getReadarrForFormat(format).isConfigured())) {
        throw new Error("Readarr is not configured yet on this computer.");
      }

      const resultsByFormat: Record<BookRequestFormat, ReadarrLookupBook[]> = {
        ebook: [],
        audiobook: [],
      };
      const searchStateByFormat: Record<
        BookRequestFormat,
        { configured: boolean; searchFailed: boolean }
      > = {
        ebook: {
          configured: getReadarrForFormat("ebook").isConfigured(),
          searchFailed: false,
        },
        audiobook: {
          configured: getReadarrForFormat("audiobook").isConfigured(),
          searchFailed: false,
        },
      };
      let searchError: Error | null = null;

      await Promise.all(
        REQUEST_FORMATS.map(async (format) => {
          if (!searchStateByFormat[format].configured) {
            return;
          }

          const readarr = getReadarrForFormat(format);

          try {
            resultsByFormat[format] = (await readarr.searchBooks(trimmedQuery)).filter(
              hasSearchResultIdentity,
            );
          } catch (error) {
            searchStateByFormat[format].searchFailed = true;
            if (!searchError) {
              searchError =
                error instanceof Error
                  ? error
                  : new Error("Search is unavailable right now. Please try again in a moment.");
            }
          }
        }),
      );

      const mergedResults = new Map<
        string,
        Partial<Record<BookRequestFormat, ReadarrLookupBook>>
      >();

      for (const format of REQUEST_FORMATS) {
        for (const result of resultsByFormat[format]) {
          const fingerprint = buildFingerprintFromLookupBook(result);
          const current = mergedResults.get(fingerprint) ?? {};
          current[format] = result;
          mergedResults.set(fingerprint, current);
        }
      }

      if (mergedResults.size === 0) {
        if (searchError) {
          throw searchError;
        }

        return [] as SearchResultItem[];
      }

      const fingerprints = Array.from(mergedResults.keys());
      const userRequests = deps.requestsRepo.findByFingerprintsForUser(userId, fingerprints);
      const systemRequests = deps.requestsRepo.findLatestByFingerprints(fingerprints);

      const requestedByUserByKey = new Map(
        userRequests.map((request) => [
          getRequestLookupKey(request.requestFormat, request.requestFingerprint),
          request,
        ]),
      );
      const systemRequestsByKey = buildRequestLookup(systemRequests);

      return fingerprints.flatMap((fingerprint) => {
        const matches = mergedResults.get(fingerprint);
        const source = matches?.ebook ?? matches?.audiobook;

        if (!matches || !source) {
          return [];
        }

        return [
          {
            fingerprint,
            title: source.title,
            author: getAuthorName(source) ?? "Unknown author",
            year: extractYear(source.releaseDate),
            coverUrl: pickBestCoverUrl(source),
            actions: {
              ebook: buildSearchAction(
                "ebook",
                matches.ebook ?? null,
                requestedByUserByKey.get(getRequestLookupKey("ebook", fingerprint)) ?? null,
                systemRequestsByKey.get(getRequestLookupKey("ebook", fingerprint)) ?? null,
                searchStateByFormat.ebook,
              ),
              audiobook: buildSearchAction(
                "audiobook",
                matches.audiobook ?? null,
                requestedByUserByKey.get(getRequestLookupKey("audiobook", fingerprint)) ?? null,
                systemRequestsByKey.get(getRequestLookupKey("audiobook", fingerprint)) ?? null,
                searchStateByFormat.audiobook,
              ),
            },
          } satisfies SearchResultItem,
        ];
      });
    },

    async createRequest(
      userId: number,
      requestFormat: BookRequestFormat,
      selection: ReadarrLookupBook,
    ) {
      const user = deps.usersRepo.getById(userId);
      if (!user) {
        throw new Error("We could not find that family member.");
      }

      const readarr = getReadarrForFormat(requestFormat);
      const fingerprint = buildFingerprintFromLookupBook(selection);
      const existing = deps.requestsRepo.findByUserAndFingerprint(
        userId,
        fingerprint,
        requestFormat,
      );
      if (existing && blocksNewRequest(existing.status)) {
        return existing;
      }

      const timestamp = deps.now();
      const draft = buildDraftRequest(userId, requestFormat, selection, timestamp);
      const created = existing
        ? deps.requestsRepo.update(existing.id, buildDraftRequestPatch(draft))
        : deps.requestsRepo.create(draft);

      if (!created) {
        throw new Error("Kindling could not save this request.");
      }

      if (!readarr.isConfigured()) {
        return deps.requestsRepo.update(created.id, {
          status: "failed",
          statusMessage:
            requestFormat === "audiobook"
              ? "The audiobook Readarr is not configured yet, so this request was saved locally for later."
              : "Readarr is not configured yet, so this request was saved locally for later.",
          notes:
            requestFormat === "audiobook"
              ? "Audiobook Readarr configuration is missing."
              : "Readarr configuration is missing.",
          updatedAt: deps.now(),
        });
      }

      try {
        const book = await readarr.addBookForRequest(selection);

        if (!book.id) {
          throw new Error("Readarr returned the book without an id.");
        }

        await readarr.monitorRequestedBook(book.id);

        let fallbackStatus: {
          status: "requested" | "searching";
          message: string;
        } = {
          status: "requested",
          message:
            requestFormat === "audiobook"
              ? "Your audiobook request has been saved."
              : "Your request has been saved.",
        };

        try {
          await readarr.triggerBookSearch(book.id);
          fallbackStatus = {
            status: "searching",
            message:
              requestFormat === "audiobook"
                ? "The audiobook Readarr is searching for this title now."
                : "Readarr is searching for this book now.",
          };
        } catch {
          fallbackStatus = {
            status: "requested",
            message:
              requestFormat === "audiobook"
                ? "Saved to the audiobook Readarr, but automatic searching could not be started."
                : "Saved to Readarr, but automatic searching could not be started.",
          };
        }

        try {
          const { book: liveBook, queueItems } = await readarr.getBookStatus(book.id);
          const mapped = mapReadarrBookToFriendlyStatus(
            liveBook,
            queueItems,
            fallbackStatus.status,
          );
          const status = mapped.status === "not-monitored" ? fallbackStatus.status : mapped.status;
          const statusMessage =
            mapped.status === "not-monitored" ? fallbackStatus.message : mapped.message;

          return deps.requestsRepo.update(created.id, {
            status,
            statusMessage,
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
          statusMessage: getFriendlyErrorMessage(error, requestFormat),
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
    deleteRequest,
    clearRequest: deleteRequest,
  };
}
