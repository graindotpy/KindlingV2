import { describe, expect, it, vi } from "vitest";
import { createRequestService } from "@/lib/requests/service";
import { ReadarrApiError } from "@/lib/readarr/service";
import type { ReadarrBookFile, ReadarrLookupBook } from "@/lib/readarr/types";
import type { BookRequestFormat, BookRequestRecord } from "@/lib/requests/types";

const FIXED_TIME = "2026-03-13T12:00:00.000Z";
const MATCHED_FILE_PATH = "C:\\Library\\Mary Norton\\The Borrowers.epub";
type MockBookStatus = {
  book: ReadarrLookupBook;
  queueItems: Array<{ id: number; bookId?: number | null; errorMessage?: string | null }>;
};

function addMilliseconds(timestamp: string, milliseconds: number) {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

function makeSelection(): ReadarrLookupBook {
  return {
    id: 0,
    title: "The Borrowers",
    foreignBookId: "goodreads:42",
    foreignEditionId: "edition:7",
    releaseDate: "1952-01-01T00:00:00.000Z",
    author: {
      id: 0,
      authorName: "Mary Norton",
      foreignAuthorId: "goodreads-author:9",
    },
    editions: [{ id: 81, monitored: true, isEbook: true }],
    statistics: { bookFileCount: 0 },
  };
}

function makeTrackedReadarrBook(overrides: Partial<ReadarrLookupBook> = {}): ReadarrLookupBook {
  const selection = makeSelection();
  const { author: authorOverrides = {}, statistics: statisticsOverrides = {}, ...rest } = overrides;

  return {
    ...selection,
    id: 101,
    monitored: true,
    lastSearchTime: null,
    ...rest,
    author: {
      ...selection.author,
      id: 51,
      ...authorOverrides,
    },
    statistics: {
      bookFileCount: 0,
      ...statisticsOverrides,
    },
  };
}

function makeBookStatus(
  bookOverrides: Partial<ReadarrLookupBook> = {},
  queueItems: Array<{ id: number; bookId?: number | null; errorMessage?: string | null }> = [],
): MockBookStatus {
  return {
    book: makeTrackedReadarrBook(bookOverrides),
    queueItems,
  };
}

function makeDeps() {
  let nextId = 1;
  let currentNow = FIXED_TIME;
  const requests: BookRequestRecord[] = [];

  function seedRequest(overrides: Partial<BookRequestRecord> = {}) {
    const selection = makeSelection();
    const record: BookRequestRecord = {
      id: nextId++,
      userId: 1,
      userName: "Mum",
      requestFormat: "ebook",
      requestFingerprint: "book:goodreads:42",
      requestedTitle: selection.title,
      requestedAuthor: selection.author.authorName,
      requestedYear: 1952,
      requestedAt: FIXED_TIME,
      status: "requested",
      statusMessage: "Your request has been saved.",
      foreignAuthorId: selection.author.foreignAuthorId,
      foreignBookId: selection.foreignBookId,
      foreignEditionId: selection.foreignEditionId ?? null,
      readarrAuthorId: 51,
      readarrBookId: 101,
      readarrEditionId: 81,
      coverUrl: null,
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
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      ...overrides,
    };

    requests.push(record);
    return record;
  }

  const requestsRepo = {
    listAll: vi.fn(() => [...requests]),
    listByUser: vi.fn((userId: number) => requests.filter((request) => request.userId === userId)),
    hasPendingSearchRetries: vi.fn(() =>
      requests.some(
        (request) =>
          request.status === "requested" && Boolean(request.nextSearchAttemptAt),
      ),
    ),
    listPendingSearchRetries: vi.fn((cutoff: string) =>
      requests
        .filter(
          (request) =>
            request.status === "requested" &&
            Boolean(request.nextSearchAttemptAt) &&
            request.nextSearchAttemptAt! <= cutoff,
        )
        .sort((left, right) =>
          (left.nextSearchAttemptAt ?? "").localeCompare(right.nextSearchAttemptAt ?? ""),
        ),
    ),
    findById: vi.fn(
      (requestId: number) => requests.find((request) => request.id === requestId) ?? null,
    ),
    findByUserAndFingerprint: vi.fn(
      (userId: number, fingerprint: string, requestFormat: BookRequestFormat) => {
        return (
          requests.find(
            (request) =>
              request.userId === userId &&
              request.requestFingerprint === fingerprint &&
              request.requestFormat === requestFormat,
          ) ?? null
        );
      },
    ),
    findByFingerprintsForUser: vi.fn((userId: number, fingerprints: string[]) => {
      return requests.filter(
        (request) =>
          request.userId === userId && fingerprints.includes(request.requestFingerprint),
      );
    }),
    findLatestByFingerprints: vi.fn((fingerprints: string[]) => {
      return requests.filter((request) => fingerprints.includes(request.requestFingerprint));
    }),
    create: vi.fn((input) => {
      const record: BookRequestRecord = {
        id: nextId++,
        userId: input.userId,
        userName: "Mum",
        requestFormat: input.requestFormat,
        requestFingerprint: input.requestFingerprint,
        requestedTitle: input.requestedTitle,
        requestedAuthor: input.requestedAuthor,
        requestedYear: input.requestedYear,
        requestedAt: input.requestedAt,
        status: input.status,
        statusMessage: input.statusMessage,
        foreignAuthorId: input.foreignAuthorId,
        foreignBookId: input.foreignBookId,
        foreignEditionId: input.foreignEditionId,
        readarrAuthorId: input.readarrAuthorId,
        readarrBookId: input.readarrBookId,
        readarrEditionId: input.readarrEditionId,
        coverUrl: input.coverUrl,
        notes: input.notes,
        searchAttemptCount: input.searchAttemptCount,
        nextSearchAttemptAt: input.nextSearchAttemptAt,
        lastSearchAttemptAt: input.lastSearchAttemptAt,
        lastSearchErrorMessage: input.lastSearchErrorMessage,
        lastSyncedAt: input.lastSyncedAt,
        matchedFilePath: input.matchedFilePath,
        matchedAt: input.matchedAt,
        lastDeliveryAt: input.lastDeliveryAt,
        lastDeliveryRecipient: input.lastDeliveryRecipient,
        lastDeliveryTrigger: input.lastDeliveryTrigger,
        lastDeliveryMessage: input.lastDeliveryMessage,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };

      requests.push(record);
      return record;
    }),
    update: vi.fn((requestId: number, patch: Partial<BookRequestRecord>) => {
      const index = requests.findIndex((request) => request.id === requestId);
      if (index === -1) {
        return null;
      }

      const current = requests[index];
      const updated: BookRequestRecord = {
        ...current,
        ...patch,
        updatedAt: patch.updatedAt ?? current.updatedAt,
      };

      requests[index] = updated;
      return updated;
    }),
  };

  const usersRepo = {
    getById: vi.fn((userId: number) =>
      userId === 1
        ? { id: 1, name: "Mum", kindleEmail: null, createdAt: FIXED_TIME, requestCount: 0 }
        : null,
    ),
  };

  const selectedBook = makeSelection();
  const readarrBook: ReadarrLookupBook = {
    ...selectedBook,
    id: 101,
    monitored: true,
    author: {
      ...selectedBook.author,
      id: 51,
    },
    lastSearchTime: FIXED_TIME,
  };

  function makeReadarr() {
    return {
      isConfigured: vi.fn(() => true),
      searchBooks: vi.fn<(query: string) => Promise<ReadarrLookupBook[]>>(async () => []),
      searchBooksByAuthor: vi.fn(async () => [] as ReadarrLookupBook[]),
      addBookForRequest: vi.fn(async () => readarrBook),
      monitorRequestedBook: vi.fn(async () => [readarrBook]),
      unmonitorRequestedBook: vi.fn(async () => [readarrBook]),
      triggerBookSearch: vi.fn(async () => ({ id: 1 })),
      getBookStatus: vi.fn<(bookId: number) => Promise<MockBookStatus>>(
        async () => ({ book: readarrBook, queueItems: [] }),
      ),
      getBookFiles: vi.fn<(bookId: number) => Promise<ReadarrBookFile[]>>(async () => []),
      deleteBookFile: vi.fn<(bookFileId: number) => Promise<null>>(async () => null),
    };
  }

  const ebookReadarr = makeReadarr();
  const audiobookReadarr = makeReadarr();

  return {
    audiobookReadarr,
    ebookReadarr,
    seedRequest,
    requestsRepo,
    service: createRequestService({
      requestsRepo: requestsRepo as never,
      usersRepo: usersRepo as never,
      readarr: {
        ebook: ebookReadarr as never,
        audiobook: audiobookReadarr as never,
      },
      now: () => currentNow,
      syncIntervalMs: 60_000,
      searchRetryDelayMs: 60_000,
      maxSearchAttempts: 4,
    }),
    setNow(timestamp: string) {
      currentNow = timestamp;
    },
  };
}

describe("createRequestService.createRequest", () => {
  it("queues an ebook request for background automatic search after linking it in Readarr", async () => {
    const { service, ebookReadarr } = makeDeps();

    const created = await service.createRequest(1, "ebook", makeSelection());

    expect(created?.status).toBe("requested");
    expect(created?.statusMessage).toContain("automatic search in about 1 minute");
    expect(created?.requestFormat).toBe("ebook");
    expect(created?.readarrBookId).toBe(101);
    expect(created?.searchAttemptCount).toBe(0);
    expect(created?.nextSearchAttemptAt).toBe(addMilliseconds(FIXED_TIME, 60_000));
    expect(ebookReadarr.addBookForRequest).toHaveBeenCalledTimes(1);
    expect(ebookReadarr.triggerBookSearch).not.toHaveBeenCalled();
  });

  it("deduplicates the same user's request for the same format before calling Readarr again", async () => {
    const { service, ebookReadarr } = makeDeps();

    const first = await service.createRequest(1, "ebook", makeSelection());
    const second = await service.createRequest(1, "ebook", makeSelection());

    expect(second?.id).toBe(first?.id);
    expect(ebookReadarr.addBookForRequest).toHaveBeenCalledTimes(1);
  });

  it("allows the same title to be requested once as EPUB and once as audiobook", async () => {
    const { service, ebookReadarr, audiobookReadarr } = makeDeps();

    const ebook = await service.createRequest(1, "ebook", makeSelection());
    const audiobook = await service.createRequest(1, "audiobook", makeSelection());

    expect(ebook?.id).not.toBe(audiobook?.id);
    expect(ebook?.requestFormat).toBe("ebook");
    expect(audiobook?.requestFormat).toBe("audiobook");
    expect(ebookReadarr.addBookForRequest).toHaveBeenCalledTimes(1);
    expect(audiobookReadarr.addBookForRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the request queued if Readarr rejects the add", async () => {
    const { service, ebookReadarr } = makeDeps();
    ebookReadarr.addBookForRequest.mockRejectedValueOnce(
      new ReadarrApiError("Readarr said no.", 500),
    );

    const created = await service.createRequest(1, "ebook", makeSelection());

    expect(created?.status).toBe("requested");
    expect(created?.statusMessage).toContain("automatic search in about 1 minute");
    expect(created?.readarrBookId).toBeNull();
    expect(created?.searchAttemptCount).toBe(0);
    expect(created?.lastSearchErrorMessage).toBe("Readarr said no.");
  });

  it("requeues a failed request when the same user asks again", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    const failed = seedRequest({
      status: "failed",
      statusMessage: "Kindling could not confirm an automatic search after repeated retries.",
      readarrAuthorId: null,
      readarrBookId: null,
      searchAttemptCount: 0,
      nextSearchAttemptAt: null,
      lastSearchAttemptAt: FIXED_TIME,
      lastSearchErrorMessage: "Readarr said no.",
      notes: "Last automatic search error: Readarr said no.",
    });

    const retried = await service.createRequest(1, "ebook", makeSelection());

    expect(retried?.id).toBe(failed?.id);
    expect(retried?.status).toBe("requested");
    expect(retried?.statusMessage).toContain("automatic search in about 1 minute");
    expect(retried?.searchAttemptCount).toBe(0);
    expect(retried?.nextSearchAttemptAt).toBe(addMilliseconds(FIXED_TIME, 60_000));
    expect(ebookReadarr.addBookForRequest).toHaveBeenCalledTimes(1);
  });

  it("lets a not monitored request be requested again later", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    const previous = seedRequest({
      status: "not-monitored",
      statusMessage: "This request is not monitored in Readarr right now.",
      matchedFilePath: null,
    });

    const retried = await service.createRequest(1, "ebook", makeSelection());

    expect(retried?.id).toBe(previous.id);
    expect(retried?.status).toBe("requested");
    expect(retried?.statusMessage).toContain("automatic search in about 1 minute");
    expect(ebookReadarr.addBookForRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the Readarr link when a post-add step fails", async () => {
    const { service, ebookReadarr } = makeDeps();
    ebookReadarr.monitorRequestedBook.mockRejectedValueOnce(
      new ReadarrApiError("Readarr said no.", 500),
    );

    const created = await service.createRequest(1, "ebook", makeSelection());

    expect(created?.status).toBe("requested");
    expect(created?.readarrBookId).toBe(101);
    expect(created?.readarrAuthorId).toBe(51);
    expect(ebookReadarr.triggerBookSearch).not.toHaveBeenCalled();
  });
});

describe("createRequestService.runAutomaticSearchRetryCycle", () => {
  it("confirms search on the first due retry and clears retry metadata", async () => {
    const { service, ebookReadarr, setNow } = makeDeps();
    const created = await service.createRequest(1, "ebook", makeSelection());
    const dueAt = created?.nextSearchAttemptAt;

    if (!dueAt) {
      throw new Error("Expected a queued retry timestamp.");
    }

    ebookReadarr.getBookStatus
      .mockResolvedValueOnce(makeBookStatus())
      .mockResolvedValueOnce(makeBookStatus())
      .mockResolvedValueOnce(makeBookStatus({ lastSearchTime: dueAt }));

    setNow(dueAt);
    const [updated] = await service.runAutomaticSearchRetryCycle();

    expect(ebookReadarr.triggerBookSearch).toHaveBeenCalledWith(101);
    expect(updated?.status).toBe("searching");
    expect(updated?.statusMessage).toContain("still searching");
    expect(updated?.searchAttemptCount).toBe(0);
    expect(updated?.nextSearchAttemptAt).toBeNull();
    expect(updated?.lastSearchAttemptAt).toBeNull();
    expect(updated?.lastSearchErrorMessage).toBeNull();
  });

  it("reschedules the retry when search cannot be confirmed yet", async () => {
    const { service, ebookReadarr, setNow } = makeDeps();
    const created = await service.createRequest(1, "ebook", makeSelection());
    const dueAt = created?.nextSearchAttemptAt;

    if (!dueAt) {
      throw new Error("Expected a queued retry timestamp.");
    }

    ebookReadarr.getBookStatus
      .mockResolvedValueOnce(makeBookStatus())
      .mockResolvedValueOnce(makeBookStatus())
      .mockResolvedValueOnce(makeBookStatus());

    setNow(dueAt);
    const [updated] = await service.runAutomaticSearchRetryCycle();

    expect(updated?.status).toBe("requested");
    expect(updated?.statusMessage).toContain("retry in about 1 minute");
    expect(updated?.searchAttemptCount).toBe(1);
    expect(updated?.lastSearchAttemptAt).toBe(dueAt);
    expect(updated?.nextSearchAttemptAt).toBe(addMilliseconds(dueAt, 60_000));
    expect(updated?.lastSearchErrorMessage).toBeNull();
    expect(ebookReadarr.triggerBookSearch).toHaveBeenCalledTimes(1);
  });

  it("marks the request failed after four unconfirmed attempts", async () => {
    const { service, ebookReadarr, setNow } = makeDeps();
    let current = await service.createRequest(1, "ebook", makeSelection());

    for (let index = 0; index < 4; index += 1) {
      const dueAt = current?.nextSearchAttemptAt;
      if (!dueAt) {
        throw new Error("Expected a queued retry timestamp.");
      }

      ebookReadarr.getBookStatus
        .mockResolvedValueOnce(makeBookStatus())
        .mockResolvedValueOnce(makeBookStatus())
        .mockResolvedValueOnce(makeBookStatus());

      setNow(dueAt);
      [current] = await service.runAutomaticSearchRetryCycle();
    }

    expect(current?.status).toBe("failed");
    expect(current?.statusMessage).toContain("after repeated retries");
    expect(current?.searchAttemptCount).toBe(0);
    expect(current?.nextSearchAttemptAt).toBeNull();
    expect(current?.lastSearchAttemptAt).toBeNull();
    expect(current?.lastSearchErrorMessage).toBeNull();
    expect(current?.notes).toContain("Automatic search could not be confirmed");
    expect(ebookReadarr.triggerBookSearch).toHaveBeenCalledTimes(4);
  });

  it("relinks a queued request after an add failure and then starts searching", async () => {
    const { service, ebookReadarr, setNow } = makeDeps();
    ebookReadarr.addBookForRequest.mockRejectedValueOnce(
      new ReadarrApiError("Readarr said no.", 500),
    );

    const created = await service.createRequest(1, "ebook", makeSelection());
    const dueAt = created?.nextSearchAttemptAt;

    if (!dueAt) {
      throw new Error("Expected a queued retry timestamp.");
    }

    ebookReadarr.searchBooks.mockResolvedValueOnce([makeSelection()]);
    ebookReadarr.getBookStatus
      .mockResolvedValueOnce(makeBookStatus())
      .mockResolvedValueOnce(makeBookStatus({ lastSearchTime: dueAt }));

    setNow(dueAt);
    const [updated] = await service.runAutomaticSearchRetryCycle();

    expect(ebookReadarr.searchBooks).toHaveBeenCalledWith("The Borrowers Mary Norton");
    expect(ebookReadarr.addBookForRequest).toHaveBeenCalledTimes(2);
    expect(updated?.status).toBe("searching");
    expect(updated?.readarrBookId).toBe(101);
    expect(updated?.searchAttemptCount).toBe(0);
    expect(updated?.nextSearchAttemptAt).toBeNull();
    expect(updated?.lastSearchErrorMessage).toBeNull();
  });

  it("relinks after a stale Readarr book id returns 404 during the retry cycle", async () => {
    const { service, ebookReadarr, seedRequest, setNow } = makeDeps();
    const queued = seedRequest({
      status: "requested",
      statusMessage: "Automatic search could not be confirmed yet. Kindling will retry in about 1 minute.",
      readarrBookId: 999,
      readarrAuthorId: 51,
      searchAttemptCount: 1,
      nextSearchAttemptAt: addMilliseconds(FIXED_TIME, 60_000),
      lastSearchAttemptAt: FIXED_TIME,
    });

    ebookReadarr.getBookStatus
      .mockRejectedValueOnce(new ReadarrApiError("Missing from Readarr.", 404))
      .mockResolvedValueOnce(makeBookStatus())
      .mockResolvedValueOnce(makeBookStatus({ lastSearchTime: addMilliseconds(FIXED_TIME, 60_000) }));
    ebookReadarr.searchBooks.mockResolvedValueOnce([makeSelection()]);

    setNow(queued.nextSearchAttemptAt ?? addMilliseconds(FIXED_TIME, 60_000));
    const [updated] = await service.runAutomaticSearchRetryCycle();

    expect(updated?.status).toBe("searching");
    expect(updated?.readarrBookId).toBe(101);
    expect(updated?.lastSearchErrorMessage).toBeNull();
    expect(ebookReadarr.searchBooks).toHaveBeenCalledTimes(1);
  });
});

describe("createRequestService.deleteRequest", () => {
  it.each(["ebook", "audiobook"] as const)("archives %s without deleting shared files or unmonitoring", async (requestFormat) => {
    const { service, ebookReadarr, audiobookReadarr, seedRequest } = makeDeps();
    const request = seedRequest({ requestFormat, status: "available", matchedFilePath: "/books/book.epub" });
    const otherReader = seedRequest({ userId: 2, requestFormat, status: "available" });
    const removed = await service.deleteRequest(request.id);
    expect(removed.status).toBe("not-monitored");
    expect(removed.statusMessage).toContain("Removed from your list");
    expect(removed.matchedFilePath).toBeNull();
    for (const backend of [ebookReadarr, audiobookReadarr]) {
      expect(backend.getBookFiles).not.toHaveBeenCalled();
      expect(backend.deleteBookFile).not.toHaveBeenCalled();
      expect(backend.unmonitorRequestedBook).not.toHaveBeenCalled();
    }
    expect((await service.listAllRequests()).map((entry) => entry.id)).toEqual([otherReader.id]);
  });

  it("can remove a linked request while Readarr is unconfigured", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    ebookReadarr.isConfigured.mockReturnValue(false);
    const request = seedRequest();
    expect((await service.deleteRequest(request.id)).status).toBe("not-monitored");
    expect(ebookReadarr.unmonitorRequestedBook).not.toHaveBeenCalled();
  });

  it("does not revive a removed request on refresh", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    const request = seedRequest();
    await service.deleteRequest(request.id);
    expect((await service.syncRequest(request.id))?.status).toBe("not-monitored");
    expect(ebookReadarr.getBookStatus).not.toHaveBeenCalled();
  });
});

describe("createRequestService.syncRequest", () => {
  it("does not display an unrelated book when Readarr reuses an old numeric id", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    const request = seedRequest({ status: "searching" });
    ebookReadarr.getBookStatus.mockResolvedValueOnce(makeBookStatus({ foreignBookId: "different-work", statistics: { bookFileCount: 1 } }));
    const synced = await service.syncRequest(request.id);
    expect(synced?.status).toBe("failed");
    expect(synced?.readarrBookId).toBeNull();
    expect(ebookReadarr.monitorRequestedBook).not.toHaveBeenCalled();
  });
  it("keeps a missing Readarr book visible with a retryable failure", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    const request = seedRequest({
      status: "searching",
      matchedFilePath: MATCHED_FILE_PATH,
      matchedAt: FIXED_TIME,
      lastDeliveryMessage: "Sent to Kindle.",
    });
    ebookReadarr.getBookStatus.mockRejectedValueOnce(
      new ReadarrApiError("Missing from Readarr.", 404),
    );

    const synced = await service.syncRequest(request.id);
    if (!synced) {
      throw new Error("Expected syncRequest to return an updated request.");
    }

    expect(synced.status).toBe("failed");
    expect(synced.statusMessage).toContain("Try again");
    expect(synced.readarrBookId).toBeNull();
    expect(synced.matchedFilePath).toBe(MATCHED_FILE_PATH);
    expect(synced.lastDeliveryMessage).toBe("Sent to Kindle.");
  });

  it("keeps unmonitored Readarr books visible with a retryable failure", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    const request = seedRequest({
      status: "searching",
    });
    ebookReadarr.getBookStatus.mockResolvedValueOnce({
      book: {
        ...makeSelection(),
        id: 101,
        monitored: false,
        author: {
          ...makeSelection().author,
          id: 51,
        },
        statistics: { bookFileCount: 0 },
      },
      queueItems: [],
    });

    const synced = await service.syncRequest(request.id);
    if (!synced) {
      throw new Error("Expected syncRequest to return an updated request.");
    }

    expect(synced.status).toBe("failed");
    expect(synced.statusMessage).toContain("not monitored");
  });
});

describe("createRequestService list visibility", () => {
  it("loads existing history without waiting for any Readarr call", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    const request = seedRequest({ updatedAt: "2020-01-01T00:00:00Z" });
    expect(await service.listRequestsForUser(1)).toEqual([request]);
    expect(await service.listAllRequests()).toEqual([request]);
    expect(ebookReadarr.getBookStatus).not.toHaveBeenCalled();
  });

  it("does not revive a request when an older refresh finishes after removal", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    const request = seedRequest();
    let resolveStatus!: (status: MockBookStatus) => void;
    ebookReadarr.getBookStatus.mockReturnValueOnce(new Promise((resolve) => { resolveStatus = resolve; }));
    const refresh = service.syncRequest(request.id);
    await service.deleteRequest(request.id);
    resolveStatus(makeBookStatus({ statistics: { bookFileCount: 1 } }));
    expect((await refresh)?.status).toBe("not-monitored");
    expect(await service.listRequestsForUser(1)).toEqual([]);
  });
  it("hides not monitored requests from the household list", async () => {
    const { service, seedRequest } = makeDeps();
    const visible = seedRequest({
      status: "searching",
    });
    seedRequest({
      status: "not-monitored",
      statusMessage: "This request is not monitored in Readarr right now.",
    });

    const requests = await service.listAllRequests();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.id).toBe(visible.id);
  });

  it("hides not monitored requests from a user's request list", async () => {
    const { service, seedRequest } = makeDeps();
    const visible = seedRequest({
      status: "available",
    });
    seedRequest({
      status: "not-monitored",
      statusMessage: "This request is not monitored in Readarr right now.",
    });

    const requests = await service.listRequestsForUser(1);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.id).toBe(visible.id);
  });
});

describe("createRequestService.searchBooksForUser", () => {
  it("only searches the selected format", async () => {
    const { service, ebookReadarr, audiobookReadarr } = makeDeps();
    audiobookReadarr.searchBooks.mockResolvedValueOnce([makeSelection()]);
    const results = await service.searchBooksForUser(1, "Borrowers", { format: "audiobook" });
    expect(results).toHaveLength(1);
    expect(ebookReadarr.searchBooks).not.toHaveBeenCalled();
    expect(results[0].actions.audiobook.source).toBeTruthy();
  });

  it("keeps results and reports a partial outage when the other format fails", async () => {
    const { service, ebookReadarr, audiobookReadarr } = makeDeps();
    ebookReadarr.searchBooks.mockResolvedValueOnce([makeSelection()]);
    audiobookReadarr.searchBooks.mockRejectedValueOnce(new Error("Connection timed out."));
    const onWarnings = vi.fn();
    const results = await service.searchBooksForUser(1, "Borrowers", { onWarnings });
    expect(results).toHaveLength(1);
    expect(results[0].actions.audiobook.availabilityLabel).toBe("Search unavailable");
    expect(onWarnings).toHaveBeenCalledWith([expect.stringContaining("Audiobook search is unavailable")]);
  });

  it("keeps active household requests ahead of newer archived entries", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    seedRequest({ userId: 2, status: "available" });
    seedRequest({ userId: 3, status: "not-monitored", updatedAt: "2026-04-01T00:00:00.000Z" });
    ebookReadarr.searchBooks.mockResolvedValueOnce([makeSelection()]);
    const results = await service.searchBooksForUser(1, "Borrowers");
    expect(results[0].actions.ebook.availability).toBe("already-available");
  });
  it("skips malformed Readarr lookup rows instead of failing the whole search", async () => {
    const { service, ebookReadarr } = makeDeps();
    const valid = makeSelection();

    ebookReadarr.searchBooks.mockResolvedValueOnce(
      [
        valid,
        {
          ...valid,
          foreignBookId: "goodreads:99",
          title: "Broken entry",
          author: undefined,
        },
      ] as unknown as ReadarrLookupBook[],
    );

    const results = await service.searchBooksForUser(1, "Borrowers");

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("The Borrowers");
    expect(ebookReadarr.searchBooks).toHaveBeenCalledWith("Borrowers");
  });

  it("keeps both formats requestable when both Readarr libraries return the title", async () => {
    const { service, ebookReadarr, audiobookReadarr } = makeDeps();
    const existingInReadarr = {
      ...makeSelection(),
      id: 101,
      author: {
        ...makeSelection().author,
        id: 51,
      },
    };

    ebookReadarr.searchBooks.mockResolvedValueOnce([existingInReadarr]);
    audiobookReadarr.searchBooks.mockResolvedValueOnce([existingInReadarr]);

    const results = await service.searchBooksForUser(1, "Way of Kings");

    expect(results).toHaveLength(1);
    expect(results[0]?.actions.ebook.availability).toBe("requestable");
    expect(results[0]?.actions.ebook.availabilityLabel).toBe("Ready to request");
    expect(results[0]?.actions.audiobook.availability).toBe("requestable");
    expect(results[0]?.actions.audiobook.availabilityLabel).toBe("Ready to request");
  });

  it("marks a format unavailable when only the other Readarr library returned a match", async () => {
    const { service, ebookReadarr } = makeDeps();
    const existingInReadarr = {
      ...makeSelection(),
      id: 101,
      author: {
        ...makeSelection().author,
        id: 51,
      },
    };

    ebookReadarr.searchBooks.mockResolvedValueOnce([existingInReadarr]);

    const results = await service.searchBooksForUser(1, "Way of Kings");

    expect(results).toHaveLength(1);
    expect(results[0]?.actions.ebook.availability).toBe("requestable");
    expect(results[0]?.actions.audiobook.availability).toBe("unavailable");
    expect(results[0]?.actions.audiobook.availabilityLabel).toBe("No match found");
    expect(results[0]?.actions.audiobook.source).toBeNull();
  });

  it("uses the resolved Goodreads author search for both formats", async () => {
    const { service, ebookReadarr, audiobookReadarr } = makeDeps();
    const selection = makeSelection();
    ebookReadarr.searchBooksByAuthor.mockResolvedValueOnce([selection]);
    audiobookReadarr.searchBooksByAuthor.mockResolvedValueOnce([selection]);
    const bookMatch = {
      authorForeignId: "4721536",
      targetTitle: "Prince of Thorns",
      alternateTitles: ["Prince of Thorns"],
    };

    const results = await service.searchBooksForUser(1, "author:4721536", { bookMatch });

    expect(results).toHaveLength(1);
    expect(ebookReadarr.searchBooksByAuthor).toHaveBeenCalledWith(bookMatch);
    expect(audiobookReadarr.searchBooksByAuthor).toHaveBeenCalledWith(bookMatch);
    expect(ebookReadarr.searchBooks).not.toHaveBeenCalled();
    expect(audiobookReadarr.searchBooks).not.toHaveBeenCalled();
  });

  it("displays the resolved title without changing either Readarr action source", async () => {
    const { service, ebookReadarr, audiobookReadarr } = makeDeps();
    const malformedTitle =
      "TheName of theWind (Kingkiller Chronicles, Day 1)2nd (second) edition Text Only";
    const ebookSelection = {
      ...makeSelection(),
      title: malformedTitle,
    };
    const audiobookSelection = {
      ...makeSelection(),
      title: "The Name of the Wind",
    };
    ebookReadarr.searchBooksByAuthor.mockResolvedValueOnce([ebookSelection]);
    audiobookReadarr.searchBooksByAuthor.mockResolvedValueOnce([audiobookSelection]);
    const bookMatch = {
      authorForeignId: "108424",
      targetTitle: "The Name of the Wind",
    };

    const results = await service.searchBooksForUser(1, "author:108424", { bookMatch });

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("The Name of the Wind");
    expect(results[0]?.actions.ebook.source?.title).toBe(malformedTitle);
    expect(results[0]?.actions.audiobook.source?.title).toBe("The Name of the Wind");
  });
});
