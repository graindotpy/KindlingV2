import { describe, expect, it, vi } from "vitest";
import { createRequestService } from "@/lib/requests/service";
import { ReadarrApiError } from "@/lib/readarr/service";
import type { ReadarrBookFile, ReadarrLookupBook } from "@/lib/readarr/types";
import type { BookRequestFormat, BookRequestRecord } from "@/lib/requests/types";

const FIXED_TIME = "2026-03-13T12:00:00.000Z";
const MATCHED_FILE_PATH = "C:\\Library\\Mary Norton\\The Borrowers.epub";

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

function makeDeps() {
  let nextId = 1;
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
      addBookForRequest: vi.fn(async () => readarrBook),
      monitorRequestedBook: vi.fn(async () => [readarrBook]),
      unmonitorRequestedBook: vi.fn(async () => [readarrBook]),
      triggerBookSearch: vi.fn(async () => ({ id: 1 })),
      getBookStatus: vi.fn(async () => ({ book: readarrBook, queueItems: [] })),
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
      now: () => FIXED_TIME,
      syncIntervalMs: 60_000,
    }),
  };
}

describe("createRequestService.createRequest", () => {
  it("creates an ebook request and marks it as searching when Readarr starts the search", async () => {
    const { service, ebookReadarr } = makeDeps();

    const created = await service.createRequest(1, "ebook", makeSelection());

    expect(created?.status).toBe("searching");
    expect(created?.requestFormat).toBe("ebook");
    expect(created?.readarrBookId).toBe(101);
    expect(ebookReadarr.addBookForRequest).toHaveBeenCalledTimes(1);
    expect(ebookReadarr.triggerBookSearch).toHaveBeenCalledTimes(1);
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

  it("keeps the failed intent locally if Readarr rejects the request", async () => {
    const { service, ebookReadarr } = makeDeps();
    ebookReadarr.addBookForRequest.mockRejectedValueOnce(
      new ReadarrApiError("Readarr said no.", 500),
    );

    const created = await service.createRequest(1, "ebook", makeSelection());

    expect(created?.status).toBe("failed");
    expect(created?.statusMessage).toContain("saved here");
  });

  it("retries a failed request instead of treating it as permanently requested", async () => {
    const { service, ebookReadarr } = makeDeps();
    ebookReadarr.addBookForRequest.mockRejectedValueOnce(
      new ReadarrApiError("Readarr said no.", 500),
    );

    const failed = await service.createRequest(1, "ebook", makeSelection());
    const retried = await service.createRequest(1, "ebook", makeSelection());

    expect(failed?.status).toBe("failed");
    expect(retried?.id).toBe(failed?.id);
    expect(retried?.status).toBe("searching");
    expect(ebookReadarr.addBookForRequest).toHaveBeenCalledTimes(2);
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
    expect(retried?.status).toBe("searching");
    expect(ebookReadarr.addBookForRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the Readarr link when a post-add step fails", async () => {
    const { service, ebookReadarr } = makeDeps();
    ebookReadarr.monitorRequestedBook.mockRejectedValueOnce(
      new ReadarrApiError("Readarr said no.", 500),
    );

    const created = await service.createRequest(1, "ebook", makeSelection());

    expect(created?.status).toBe("searching");
    expect(created?.readarrBookId).toBe(101);
    expect(created?.readarrAuthorId).toBe(51);
  });

  it("retries automatic search when Readarr does not show it right away", async () => {
    vi.useFakeTimers();

    try {
      const { service, ebookReadarr } = makeDeps();
      const idleStatus = {
        book: {
          ...makeSelection(),
          id: 101,
          monitored: true,
          author: {
            ...makeSelection().author,
            id: 51,
          },
          lastSearchTime: null,
          statistics: { bookFileCount: 0 },
        },
        queueItems: [],
      };
      const searchingStatus = {
        book: {
          ...idleStatus.book,
          lastSearchTime: FIXED_TIME,
        },
        queueItems: [],
      };

      ebookReadarr.getBookStatus
        .mockResolvedValueOnce(idleStatus)
        .mockResolvedValueOnce(idleStatus)
        .mockResolvedValueOnce(searchingStatus);

      const pending = service.createRequest(1, "ebook", makeSelection());
      await vi.runAllTimersAsync();
      const created = await pending;

      expect(ebookReadarr.triggerBookSearch).toHaveBeenCalledTimes(2);
      expect(created?.status).toBe("searching");
      expect(created?.statusMessage).toContain("searching");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the request as requested when automatic search cannot be confirmed yet", async () => {
    vi.useFakeTimers();

    try {
      const { service, ebookReadarr } = makeDeps();
      const idleStatus = {
        book: {
          ...makeSelection(),
          id: 101,
          monitored: true,
          author: {
            ...makeSelection().author,
            id: 51,
          },
          lastSearchTime: null,
          statistics: { bookFileCount: 0 },
        },
        queueItems: [],
      };

      ebookReadarr.getBookStatus.mockResolvedValue(idleStatus);

      const pending = service.createRequest(1, "ebook", makeSelection());
      await vi.runAllTimersAsync();
      const created = await pending;

      expect(ebookReadarr.triggerBookSearch).toHaveBeenCalledTimes(4);
      expect(created?.status).toBe("requested");
      expect(created?.statusMessage).toContain("could not be confirmed yet");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createRequestService.deleteRequest", () => {
  it("deletes an existing Readarr file and unmonitors the book", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    const request = seedRequest({
      status: "available",
      statusMessage: "Book found in watched folder.",
      matchedFilePath: "C:\\Books\\The Borrowers.epub",
      matchedAt: FIXED_TIME,
      lastDeliveryAt: FIXED_TIME,
      lastDeliveryRecipient: "mum@kindle.com",
      lastDeliveryTrigger: "manual",
      lastDeliveryMessage: "Sent to Kindle.",
    });
    ebookReadarr.getBookFiles.mockResolvedValueOnce([
      {
        id: 700,
        bookId: 101,
        path: "C:\\Books\\The Borrowers.epub",
      },
    ]);

    const deleted = await service.deleteRequest(request.id);

    expect(ebookReadarr.deleteBookFile).toHaveBeenCalledWith(700);
    expect(ebookReadarr.unmonitorRequestedBook).toHaveBeenCalledWith(101);
    expect(ebookReadarr.triggerBookSearch).not.toHaveBeenCalled();
    expect(deleted.status).toBe("not-monitored");
    expect(deleted.statusMessage).toContain("stopped monitoring");
    expect(deleted.matchedFilePath).toBeNull();
    expect(deleted.lastDeliveryMessage).toBeNull();
  });

  it("marks the request as not monitored even when Readarr no longer has the book", async () => {
    const { service, ebookReadarr, seedRequest } = makeDeps();
    const request = seedRequest({
      status: "available",
      statusMessage: "Book found in watched folder.",
      matchedFilePath: "C:\\Books\\Missing.epub",
      matchedAt: FIXED_TIME,
    });
    ebookReadarr.getBookFiles.mockRejectedValueOnce(
      new ReadarrApiError("Missing from Readarr.", 404),
    );

    const deleted = await service.deleteRequest(request.id);

    expect(ebookReadarr.deleteBookFile).not.toHaveBeenCalled();
    expect(ebookReadarr.unmonitorRequestedBook).not.toHaveBeenCalled();
    expect(deleted.status).toBe("not-monitored");
    expect(deleted.statusMessage).toContain("reset to Not Monitored");
    expect(deleted.readarrBookId).toBeNull();
    expect(deleted.matchedFilePath).toBeNull();
  });

  it("can reset a local-only request without calling Readarr", async () => {
    const { service, ebookReadarr, audiobookReadarr, seedRequest } = makeDeps();
    const request = seedRequest({
      status: "failed",
      statusMessage: "Readarr said no.",
      readarrAuthorId: null,
      readarrBookId: null,
      readarrEditionId: null,
      notes: "The request intent was saved locally even though Readarr could not finish it.",
    });

    const deleted = await service.deleteRequest(request.id);

    expect(ebookReadarr.getBookFiles).not.toHaveBeenCalled();
    expect(ebookReadarr.unmonitorRequestedBook).not.toHaveBeenCalled();
    expect(audiobookReadarr.unmonitorRequestedBook).not.toHaveBeenCalled();
    expect(deleted.status).toBe("not-monitored");
    expect(deleted.statusMessage).toContain("reset to Not Monitored");
    expect(deleted.readarrBookId).toBeNull();
    expect(deleted.notes).toBeNull();
  });

  it("supports deleting audiobook requests too", async () => {
    const { service, audiobookReadarr, seedRequest } = makeDeps();
    const request = seedRequest({
      requestFormat: "audiobook",
    });

    const deleted = await service.deleteRequest(request.id);

    expect(audiobookReadarr.unmonitorRequestedBook).toHaveBeenCalledWith(101);
    expect(deleted.status).toBe("not-monitored");
  });
});

describe("createRequestService.syncRequest", () => {
  it("resets a missing Readarr book to not monitored", async () => {
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

    expect(synced.status).toBe("not-monitored");
    expect(synced.statusMessage).toContain("reset to Not Monitored");
    expect(synced.readarrBookId).toBeNull();
    expect(synced.matchedFilePath).toBeNull();
    expect(synced.lastDeliveryMessage).toBeNull();
  });

  it("shows unmonitored Readarr books as not monitored", async () => {
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

    expect(synced.status).toBe("not-monitored");
    expect(synced.statusMessage).toContain("not monitored");
  });
});

describe("createRequestService list visibility", () => {
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
});
