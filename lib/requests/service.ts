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
const AUTOMATIC_SEARCH_DELAY_MS = 60_000;
const AUTOMATIC_SEARCH_MAX_ATTEMPTS = 4;

type RequestsRepository = ReturnType<typeof createBookRequestsRepository>;
type UsersRepository = ReturnType<typeof createUsersRepository>;
type ReadarrServices = Record<BookRequestFormat, ReadarrService>;
type ReadarrBookStatus = Awaited<ReturnType<ReadarrService["getBookStatus"]>>;

type RequestServiceDependencies = {
  requestsRepo: RequestsRepository;
  usersRepo: UsersRepository;
  readarr: ReadarrServices;
  now: () => string;
  syncIntervalMs: number;
  searchRetryDelayMs: number;
  maxSearchAttempts: number;
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

function getPersistedReadarrId(value: number | null | undefined) {
  return typeof value === "number" && value > 0 ? value : null;
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
    readarrAuthorId: getPersistedReadarrId(selection.author.id),
    readarrBookId: getPersistedReadarrId(selection.id),
    readarrEditionId: pickPreferredEditionId(selection),
    coverUrl: pickBestCoverUrl(selection),
    notes: null,
    searchAttemptCount: 0,
    nextSearchAttemptAt: null,
    lastSearchAttemptAt: null,
    lastSearchErrorMessage: null,
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
    searchAttemptCount: draft.searchAttemptCount,
    nextSearchAttemptAt: draft.nextSearchAttemptAt,
    lastSearchAttemptAt: draft.lastSearchAttemptAt,
    lastSearchErrorMessage: draft.lastSearchErrorMessage,
    lastSyncedAt: draft.lastSyncedAt,
    updatedAt: draft.updatedAt,
  };
}

function buildLinkedReadarrPatch(
  current: BookRequestRecord,
  book: ReadarrLookupBook,
  updatedAt: string,
  extra: Partial<BookRequestRecord> = {},
) {
  return {
    foreignAuthorId: book.author.foreignAuthorId ?? current.foreignAuthorId,
    foreignBookId: book.foreignBookId ?? current.foreignBookId,
    foreignEditionId: book.foreignEditionId ?? current.foreignEditionId,
    readarrAuthorId: book.author.id ?? current.readarrAuthorId,
    readarrBookId: book.id ?? current.readarrBookId,
    readarrEditionId: pickPreferredEditionId(book) ?? current.readarrEditionId,
    coverUrl: pickBestCoverUrl(book) ?? current.coverUrl,
    searchAttemptCount: current.searchAttemptCount,
    nextSearchAttemptAt: current.nextSearchAttemptAt,
    lastSearchAttemptAt: current.lastSearchAttemptAt,
    lastSearchErrorMessage: current.lastSearchErrorMessage,
    updatedAt,
    ...extra,
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

function getInitialSearchQueueMessage(format: BookRequestFormat) {
  return format === "audiobook"
    ? "Your audiobook request has been saved. Kindling will try automatic search in about 1 minute."
    : "Your request has been saved. Kindling will try automatic search in about 1 minute.";
}

function getRetryScheduledMessage(format: BookRequestFormat) {
  return format === "audiobook"
    ? "Automatic audiobook search could not be confirmed yet. Kindling will retry in about 1 minute."
    : "Automatic search could not be confirmed yet. Kindling will retry in about 1 minute.";
}

function getAutomaticSearchFailedMessage(format: BookRequestFormat) {
  return format === "audiobook"
    ? "Kindling could not confirm an automatic audiobook search after repeated retries."
    : "Kindling could not confirm an automatic search after repeated retries.";
}

function getAutomaticSearchErrorMessage(error: unknown, format: BookRequestFormat) {
  if (error instanceof ReadarrApiError) {
    if (error.status === 503) {
      return format === "audiobook"
        ? "The audiobook Readarr is not configured yet on this computer."
        : "Readarr is not configured yet on this computer.";
    }

    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return format === "audiobook"
    ? "Kindling could not confirm automatic audiobook searching yet."
    : "Kindling could not confirm automatic searching yet.";
}

function addMilliseconds(timestamp: string, milliseconds: number) {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

function normalizeLookupText(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function clearSearchRetryState() {
  return {
    searchAttemptCount: 0,
    nextSearchAttemptAt: null,
    lastSearchAttemptAt: null,
    lastSearchErrorMessage: null,
  };
}

function buildQueuedSearchRetryPatch(
  format: BookRequestFormat,
  timestamp: string,
  delayMs: number,
  attemptCount: number,
  lastErrorMessage: string | null,
) {
  return {
    status: "requested" as const,
    statusMessage:
      attemptCount === 0
        ? getInitialSearchQueueMessage(format)
        : getRetryScheduledMessage(format),
    searchAttemptCount: attemptCount,
    nextSearchAttemptAt: addMilliseconds(timestamp, delayMs),
    lastSearchAttemptAt: attemptCount > 0 ? timestamp : null,
    lastSearchErrorMessage: lastErrorMessage,
    notes: null,
    updatedAt: timestamp,
  };
}

function buildFailedSearchRetryPatch(
  format: BookRequestFormat,
  timestamp: string,
  lastErrorMessage: string | null,
) {
  return {
    status: "failed" as const,
    statusMessage: getAutomaticSearchFailedMessage(format),
    notes: lastErrorMessage
      ? `Last automatic search error: ${lastErrorMessage}`
      : "Automatic search could not be confirmed after repeated retries.",
    ...clearSearchRetryState(),
    updatedAt: timestamp,
  };
}

function matchesRequestSelection(
  request: BookRequestRecord,
  result: ReadarrLookupBook,
) {
  if (buildFingerprintFromLookupBook(result) === request.requestFingerprint) {
    return true;
  }

  if (request.foreignBookId && result.foreignBookId === request.foreignBookId) {
    return true;
  }

  if (request.foreignEditionId && result.foreignEditionId === request.foreignEditionId) {
    return true;
  }

  return (
    normalizeLookupText(result.title) === normalizeLookupText(request.requestedTitle) &&
    normalizeLookupText(getAuthorName(result)) === normalizeLookupText(request.requestedAuthor)
  );
}

function hasActiveQueueItem(status: ReadarrBookStatus) {
  return status.queueItems.some((item) => item.bookId === status.book.id);
}

function hasConfirmedSearchActivity(status: ReadarrBookStatus) {
  return (
    (status.book.statistics?.bookFileCount ?? 0) > 0 ||
    hasActiveQueueItem(status) ||
    Boolean(status.book.lastSearchTime)
  );
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
    searchRetryDelayMs: partialDeps.searchRetryDelayMs ?? AUTOMATIC_SEARCH_DELAY_MS,
    maxSearchAttempts: partialDeps.maxSearchAttempts ?? AUTOMATIC_SEARCH_MAX_ATTEMPTS,
  };

  function getReadarrForFormat(format: BookRequestFormat) {
    return deps.readarr[format];
  }

  function clearSearchRetryStatePatch(updatedAt: string) {
    return {
      ...clearSearchRetryState(),
      updatedAt,
    };
  }

  function queueSearchRetry(
    request: BookRequestRecord,
    options: {
      timestamp?: string;
      attemptCount: number;
      lastErrorMessage?: string | null;
    },
  ) {
    const timestamp = options.timestamp ?? deps.now();
    return (
      deps.requestsRepo.update(
        request.id,
        buildQueuedSearchRetryPatch(
          request.requestFormat,
          timestamp,
          deps.searchRetryDelayMs,
          options.attemptCount,
          options.lastErrorMessage ?? null,
        ),
      ) ?? request
    );
  }

  function failQueuedSearchRetry(
    request: BookRequestRecord,
    options: {
      timestamp?: string;
      lastErrorMessage?: string | null;
    },
  ) {
    const timestamp = options.timestamp ?? deps.now();
    return (
      deps.requestsRepo.update(
        request.id,
        buildFailedSearchRetryPatch(
          request.requestFormat,
          timestamp,
          options.lastErrorMessage ?? null,
        ),
      ) ?? request
    );
  }

  async function findLookupBookForRequest(request: BookRequestRecord) {
    const readarr = getReadarrForFormat(request.requestFormat);
    const query = `${request.requestedTitle} ${request.requestedAuthor}`.trim();
    if (!query) {
      return null;
    }

    const results = await readarr.searchBooks(query);
    return results.find((result) => matchesRequestSelection(request, result)) ?? null;
  }

  function clearStaleReadarrLink(request: BookRequestRecord, updatedAt: string) {
    return (
      deps.requestsRepo.update(request.id, {
        readarrBookId: null,
        readarrEditionId: null,
        lastSyncedAt: updatedAt,
        updatedAt,
      }) ?? request
    );
  }

  function mapConfirmedSearchStatus(
    request: BookRequestRecord,
    liveStatus: ReadarrBookStatus,
    updatedAt: string,
  ) {
    const mapped = mapReadarrBookToFriendlyStatus(liveStatus.book, liveStatus.queueItems, "searching");

    return (
      deps.requestsRepo.update(request.id, {
        status: mapped.status,
        statusMessage: mapped.message,
        foreignAuthorId: liveStatus.book.author.foreignAuthorId ?? request.foreignAuthorId,
        foreignBookId: liveStatus.book.foreignBookId ?? request.foreignBookId,
        foreignEditionId: liveStatus.book.foreignEditionId ?? request.foreignEditionId,
        readarrAuthorId: liveStatus.book.author.id ?? request.readarrAuthorId,
        readarrBookId: liveStatus.book.id ?? request.readarrBookId,
        readarrEditionId: pickPreferredEditionId(liveStatus.book) ?? request.readarrEditionId,
        coverUrl: pickBestCoverUrl(liveStatus.book) ?? request.coverUrl,
        notes: null,
        lastSyncedAt: updatedAt,
        ...clearSearchRetryStatePatch(updatedAt),
      }) ?? request
    );
  }

  async function ensureLinkedBookForRetry(request: BookRequestRecord, timestamp: string) {
    const readarr = getReadarrForFormat(request.requestFormat);
    const selection = await findLookupBookForRequest(request);

    if (!selection) {
      throw new Error(
        request.requestFormat === "audiobook"
          ? "Kindling could not find this audiobook in Readarr yet."
          : "Kindling could not find this book in Readarr yet.",
      );
    }

    const book = await readarr.addBookForRequest(selection);

    if (!book.id) {
      throw new Error("Readarr returned the book without an id.");
    }

    const linked =
      deps.requestsRepo.update(
        request.id,
        buildLinkedReadarrPatch(request, book, timestamp, {
          lastSyncedAt: timestamp,
        }),
      ) ?? request;

    try {
      await readarr.monitorRequestedBook(book.id);
    } catch {
      // Readarr already has the book; retry cycles can still reconcile and trigger search.
    }

    return linked;
  }

  async function processQueuedSearchRetry(request: BookRequestRecord) {
    const readarr = getReadarrForFormat(request.requestFormat);
    const startedAt = deps.now();
    let current = request;

    if (current.readarrBookId) {
      try {
        const liveStatus = await readarr.getBookStatus(current.readarrBookId);
        if (hasConfirmedSearchActivity(liveStatus)) {
          return mapConfirmedSearchStatus(current, liveStatus, startedAt);
        }
      } catch (error) {
        if (error instanceof ReadarrApiError && error.status === 404) {
          current = clearStaleReadarrLink(current, startedAt);
        }
      }
    }

    const attemptCount = current.searchAttemptCount + 1;
    let lastErrorMessage: string | null = null;

    try {
      if (!current.readarrBookId) {
        current = await ensureLinkedBookForRetry(current, startedAt);
      }

      if (!current.readarrBookId) {
        throw new Error("Kindling could not link this request to Readarr yet.");
      }

      try {
        const liveStatus = await readarr.getBookStatus(current.readarrBookId);
        if (hasConfirmedSearchActivity(liveStatus)) {
          return mapConfirmedSearchStatus(current, liveStatus, startedAt);
        }
      } catch (error) {
        if (error instanceof ReadarrApiError && error.status === 404) {
          current = clearStaleReadarrLink(current, startedAt);
          current = await ensureLinkedBookForRetry(current, startedAt);
        } else {
          lastErrorMessage = getAutomaticSearchErrorMessage(error, current.requestFormat);
        }
      }

      if (!current.readarrBookId) {
        throw new Error("Kindling could not link this request to Readarr yet.");
      }

      try {
        await readarr.triggerBookSearch(current.readarrBookId);
      } catch (error) {
        lastErrorMessage = getAutomaticSearchErrorMessage(error, current.requestFormat);
      }

      try {
        const liveStatus = await readarr.getBookStatus(current.readarrBookId);
        if (hasConfirmedSearchActivity(liveStatus)) {
          return mapConfirmedSearchStatus(current, liveStatus, startedAt);
        }
      } catch (error) {
        if (error instanceof ReadarrApiError && error.status === 404) {
          current = clearStaleReadarrLink(current, startedAt);
        } else if (!lastErrorMessage) {
          lastErrorMessage = getAutomaticSearchErrorMessage(error, current.requestFormat);
        }
      }
    } catch (error) {
      lastErrorMessage = getAutomaticSearchErrorMessage(error, current.requestFormat);
    }

    if (attemptCount >= deps.maxSearchAttempts) {
      return failQueuedSearchRetry(current, {
        timestamp: startedAt,
        lastErrorMessage,
      });
    }

    return queueSearchRetry(current, {
      timestamp: startedAt,
      attemptCount,
      lastErrorMessage,
    });
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
      ...clearSearchRetryState(),
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

      const updatedAt = deps.now();
      return deps.requestsRepo.update(record.id, {
        status: mapped.status,
        statusMessage: mapped.message,
        coverUrl: pickBestCoverUrl(book) ?? record.coverUrl,
        readarrAuthorId: book.author.id ?? record.readarrAuthorId,
        readarrBookId: book.id ?? record.readarrBookId,
        readarrEditionId: pickPreferredEditionId(book) ?? record.readarrEditionId,
        notes: mapped.status === "failed" ? record.notes : null,
        ...(mapped.status === "requested" ? {} : clearSearchRetryState()),
        lastSyncedAt: updatedAt,
        updatedAt,
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
        !request.nextSearchAttemptAt &&
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

        const linkedRequest =
          deps.requestsRepo.update(
            created.id,
            buildLinkedReadarrPatch(created, book, deps.now(), {
              lastSyncedAt: deps.now(),
            }),
          ) ?? created;

        try {
          await readarr.monitorRequestedBook(book.id);
        } catch {
          // Readarr already received the book add, so keep the local request linked.
        }

        return queueSearchRetry(linkedRequest, {
          attemptCount: 0,
        });
      } catch (error) {
        return queueSearchRetry(created, {
          attemptCount: 0,
          lastErrorMessage: getAutomaticSearchErrorMessage(error, requestFormat),
        });
      }
    },

    async runAutomaticSearchRetryCycle() {
      const dueRequests = deps.requestsRepo.listPendingSearchRetries(deps.now());
      const updates: BookRequestRecord[] = [];

      for (const request of dueRequests) {
        updates.push(await processQueuedSearchRetry(request));
      }

      return updates;
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
