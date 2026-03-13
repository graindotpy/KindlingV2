import { describe, expect, it, vi } from "vitest";
import { createRequestService } from "@/lib/requests/service";
import { ReadarrApiError } from "@/lib/readarr/service";
import type { ReadarrLookupBook } from "@/lib/readarr/types";
import type { BookRequestRecord } from "@/lib/requests/types";

const FIXED_TIME = "2026-03-13T12:00:00.000Z";

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

  const requestsRepo = {
    listAll: vi.fn(() => [...requests]),
    listByUser: vi.fn((userId: number) => requests.filter((request) => request.userId === userId)),
    findById: vi.fn((requestId: number) => requests.find((request) => request.id === requestId) ?? null),
    findByUserAndFingerprint: vi.fn((userId: number, fingerprint: string) => {
      return (
        requests.find(
          (request) =>
            request.userId === userId && request.requestFingerprint === fingerprint,
        ) ?? null
      );
    }),
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
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };

      requests.push(record);
      return record;
    }),
    update: vi.fn((requestId: number, patch) => {
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
      userId === 1 ? { id: 1, name: "Mum", createdAt: FIXED_TIME } : null,
    ),
  };

  const selectedBook = makeSelection();
  const readarrBook: ReadarrLookupBook = {
    ...selectedBook,
    id: 101,
    author: {
      ...selectedBook.author,
      id: 51,
    },
    lastSearchTime: FIXED_TIME,
  };

  const readarr = {
    isConfigured: vi.fn(() => true),
    searchBooks: vi.fn<(query: string) => Promise<ReadarrLookupBook[]>>(async () => []),
    addBookForRequest: vi.fn(async () => readarrBook),
    monitorRequestedBook: vi.fn(async () => [readarrBook]),
    triggerBookSearch: vi.fn(async () => ({ id: 1 })),
    getBookStatus: vi.fn(async () => ({ book: readarrBook, queueItems: [] })),
  };

  return {
    readarr,
    service: createRequestService({
      requestsRepo: requestsRepo as never,
      usersRepo: usersRepo as never,
      readarr: readarr as never,
      now: () => FIXED_TIME,
      syncIntervalMs: 60_000,
    }),
  };
}

describe("createRequestService.createRequest", () => {
  it("creates a request and marks it as searching when Readarr starts the search", async () => {
    const { service, readarr } = makeDeps();

    const created = await service.createRequest(1, makeSelection());

    expect(created?.status).toBe("searching");
    expect(created?.readarrBookId).toBe(101);
    expect(readarr.addBookForRequest).toHaveBeenCalledTimes(1);
    expect(readarr.triggerBookSearch).toHaveBeenCalledTimes(1);
  });

  it("deduplicates the same user's request before calling Readarr again", async () => {
    const { service, readarr } = makeDeps();

    const first = await service.createRequest(1, makeSelection());
    const second = await service.createRequest(1, makeSelection());

    expect(second?.id).toBe(first?.id);
    expect(readarr.addBookForRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the failed intent locally if Readarr rejects the request", async () => {
    const { service, readarr } = makeDeps();
    readarr.addBookForRequest.mockRejectedValueOnce(
      new ReadarrApiError("Readarr said no.", 500),
    );

    const created = await service.createRequest(1, makeSelection());

    expect(created?.status).toBe("failed");
    expect(created?.statusMessage).toContain("saved here");
  });

  it("retries a failed request instead of treating it as permanently requested", async () => {
    const { service, readarr } = makeDeps();
    readarr.addBookForRequest.mockRejectedValueOnce(
      new ReadarrApiError("Readarr said no.", 500),
    );

    const failed = await service.createRequest(1, makeSelection());
    const retried = await service.createRequest(1, makeSelection());

    expect(failed?.status).toBe("failed");
    expect(retried?.id).toBe(failed?.id);
    expect(retried?.status).toBe("searching");
    expect(readarr.addBookForRequest).toHaveBeenCalledTimes(2);
  });
});

describe("createRequestService.searchBooksForUser", () => {
  it("skips malformed Readarr lookup rows instead of failing the whole search", async () => {
    const { service, readarr } = makeDeps();
    const valid = makeSelection();

    readarr.searchBooks.mockResolvedValueOnce(
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
    expect(readarr.searchBooks).toHaveBeenCalledWith("Borrowers");
  });

  it("keeps a Readarr hit requestable when Kindling has no matching saved request", async () => {
    const { service, readarr } = makeDeps();
    const existingInReadarr = {
      ...makeSelection(),
      id: 101,
      author: {
        ...makeSelection().author,
        id: 51,
      },
    };

    readarr.searchBooks.mockResolvedValueOnce([existingInReadarr]);

    const results = await service.searchBooksForUser(1, "Way of Kings");

    expect(results).toHaveLength(1);
    expect(results[0]?.availability).toBe("requestable");
    expect(results[0]?.availabilityLabel).toBe("Ready to request");
  });
});
