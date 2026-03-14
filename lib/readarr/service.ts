import { getReadarrConfig, isReadarrConfigured } from "@/lib/config";
import type { BookRequestFormat } from "@/lib/requests/types";
import type {
  ReadarrAuthor,
  ReadarrBookFile,
  ReadarrLookupBook,
  ReadarrMetadataProfile,
  ReadarrQualityProfile,
  ReadarrQueueItem,
  ReadarrRootFolder,
  ReadarrSystemStatus,
} from "@/lib/readarr/types";

type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean>;

type ReadarrDefaults = {
  rootFolderPath: string;
  qualityProfileId: number;
  metadataProfileId: number;
};

type ReadarrLookupSearchBook = Omit<ReadarrLookupBook, "author"> & {
  author?: ReadarrAuthor;
  authorTitle?: string | null;
};

const cachedDefaultsByFormat: Partial<Record<BookRequestFormat, ReadarrDefaults>> = {};
// Readarr can finish an async author refresh several seconds after a failed add-book response.
const POST_ADD_LOOKUP_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];

export class ReadarrApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ReadarrApiError";
    this.status = status;
  }
}

function getErrorMessage(payload: unknown) {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;

    for (const key of ["message", "errorMessage", "error", "title"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    if (Array.isArray(payload)) {
      const first = payload.find(
        (entry) => typeof entry === "object" && entry !== null && "message" in entry,
      ) as Record<string, unknown> | undefined;

      if (typeof first?.message === "string") {
        return first.message;
      }
    }
  }

  return null;
}

async function parseResponseBody(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getReadarrConfigErrorMessage(format: BookRequestFormat) {
  return format === "audiobook"
    ? "Audiobook Readarr is not configured yet. Add AUDIOBOOK_READARR_BASE_URL and AUDIOBOOK_READARR_API_KEY."
    : "Readarr is not configured yet. Add READARR_BASE_URL and READARR_API_KEY.";
}

function buildUrl(
  format: BookRequestFormat,
  pathname: string,
  query?: Record<string, QueryValue>,
) {
  const config = getReadarrConfig(format);
  const baseUrl = config.baseUrl;

  if (!baseUrl) {
    throw new ReadarrApiError(getReadarrConfigErrorMessage(format), 503);
  }

  const url = new URL(pathname, `${baseUrl}/`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          url.searchParams.append(key, String(entry));
        }
        continue;
      }

      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

async function readarrFetch<T>(
  format: BookRequestFormat,
  pathname: string,
  init?: RequestInit,
  query?: Record<string, QueryValue>,
): Promise<T> {
  const config = getReadarrConfig(format);
  const apiKey = config.apiKey;

  if (!apiKey) {
    throw new ReadarrApiError(getReadarrConfigErrorMessage(format), 503);
  }

  const response = await fetch(buildUrl(format, pathname, query), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  const payload = await parseResponseBody(response);

  if (!response.ok) {
    throw new ReadarrApiError(
      getErrorMessage(payload) ??
        `Readarr returned ${response.status} ${response.statusText}.`,
      response.status,
    );
  }

  return payload as T;
}

function pickMatchingBook(books: ReadarrLookupBook[], selection: ReadarrLookupBook) {
  return (
    books.find((book) => book.foreignBookId === selection.foreignBookId) ??
    books.find(
      (book) => book.titleSlug && selection.titleSlug && book.titleSlug === selection.titleSlug,
    ) ??
    null
  );
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function toDisplayAuthorName(value: string) {
  const trimmed = value.trim();
  if (!trimmed.includes(",")) {
    return trimmed
      .split(/\s+/)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(" ");
  }

  const [lastName, firstName] = trimmed.split(",", 2).map((segment) => segment.trim());
  return [firstName, lastName].filter(Boolean).join(" ");
}

function extractAuthorSearchName(book: ReadarrLookupSearchBook) {
  if (book.author?.authorName?.trim()) {
    return book.author.authorName.trim();
  }

  const authorTitle = book.authorTitle?.trim();
  if (!authorTitle) {
    return null;
  }

  const title = book.title?.trim();
  if (title) {
    const suffixPattern = new RegExp(`${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    const withoutTitle = authorTitle.replace(suffixPattern, "").trim();
    if (withoutTitle) {
      return toDisplayAuthorName(withoutTitle);
    }
  }

  return toDisplayAuthorName(authorTitle);
}

function selectMatchingAuthor(authors: ReadarrAuthor[], authorName: string) {
  const target = normalizeText(authorName);

  return (
    authors.find((author) => normalizeText(author.authorName) === target) ??
    authors.find(
      (author) => author.authorNameLastFirst && normalizeText(author.authorNameLastFirst) === target,
    ) ??
    authors[0] ??
    null
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pickBestCoverUrl(resource: {
  remoteCover?: string | null;
  remotePoster?: string | null;
  images?: Array<{ remoteUrl?: string | null; url?: string | null }> | null;
}) {
  return (
    resource.remoteCover ??
    resource.remotePoster ??
    resource.images?.find((image) => image.remoteUrl || image.url)?.remoteUrl ??
    resource.images?.find((image) => image.remoteUrl || image.url)?.url ??
    null
  );
}

export function pickPreferredEditionId(book: ReadarrLookupBook) {
  const monitoredEdition = book.editions?.find((edition) => edition.monitored);
  return monitoredEdition?.id ?? book.editions?.[0]?.id ?? null;
}

export function createReadarrService(format: BookRequestFormat = "ebook") {
  async function getRootFolders() {
    return readarrFetch<ReadarrRootFolder[]>(format, "/api/v1/rootfolder");
  }

  async function getQualityProfiles() {
    return readarrFetch<ReadarrQualityProfile[]>(format, "/api/v1/qualityprofile");
  }

  async function getMetadataProfiles() {
    return readarrFetch<ReadarrMetadataProfile[]>(format, "/api/v1/metadataprofile");
  }

  async function resolveDefaults(): Promise<ReadarrDefaults> {
    const cachedDefaults = cachedDefaultsByFormat[format];
    if (cachedDefaults) {
      return cachedDefaults;
    }

    const config = getReadarrConfig(format);

    const [rootFolders, qualityProfiles, metadataProfiles] = await Promise.all([
      getRootFolders(),
      getQualityProfiles(),
      getMetadataProfiles(),
    ]);

    const rootFolderPath = config.rootFolderPath ?? rootFolders[0]?.path;
    const qualityProfileId =
      config.qualityProfileId ??
      rootFolders[0]?.defaultQualityProfileId ??
      qualityProfiles[0]?.id;
    const metadataProfileId =
      config.metadataProfileId ??
      rootFolders[0]?.defaultMetadataProfileId ??
      metadataProfiles[0]?.id;

    if (!rootFolderPath || !qualityProfileId || !metadataProfileId) {
      throw new ReadarrApiError(
        "Readarr is missing a usable root folder or profile configuration.",
        400,
      );
    }

    cachedDefaultsByFormat[format] = {
      rootFolderPath,
      qualityProfileId,
      metadataProfileId,
    };

    return cachedDefaultsByFormat[format] as ReadarrDefaults;
  }

  async function getBooksByAuthor(authorId: number) {
    return readarrFetch<ReadarrLookupBook[]>(format, "/api/v1/book", undefined, { authorId });
  }

  async function lookupAuthorByName(authorName: string) {
    const authors = await readarrFetch<ReadarrAuthor[]>(
      format,
      "/api/v1/author/lookup",
      undefined,
      {
        term: authorName,
      },
    );

    return selectMatchingAuthor(authors, authorName);
  }

  async function enrichLookupBooks(books: ReadarrLookupSearchBook[]) {
    const authorNames = Array.from(
      new Set(
        books
          .filter((book) => !book.author?.authorName)
          .map(extractAuthorSearchName)
          .filter((name): name is string => Boolean(name)),
      ),
    );

    if (authorNames.length === 0) {
      return books as ReadarrLookupBook[];
    }

    const authorEntries = await Promise.all(
      authorNames.map(async (authorName) => {
        try {
          return [authorName, await lookupAuthorByName(authorName)] as const;
        } catch {
          return [authorName, null] as const;
        }
      }),
    );
    const authorsByName = new Map(authorEntries);

    return books.flatMap((book) => {
      if (book.author?.authorName) {
        return [book as ReadarrLookupBook];
      }

      const authorName = extractAuthorSearchName(book);
      const author = authorName ? authorsByName.get(authorName) ?? null : null;

      if (!author?.authorName || !author.foreignAuthorId) {
        return [];
      }

      return [
        {
          ...book,
          authorId: book.authorId && book.authorId > 0 ? book.authorId : author.id,
          author,
        } satisfies ReadarrLookupBook,
      ];
    });
  }

  async function findExistingBookForSelection(
    selection: ReadarrLookupBook,
    authorId: number,
  ) {
    if (selection.id && selection.id > 0) {
      try {
        return await service.getBook(selection.id);
      } catch {
        // Ignore and fall back to author lookup.
      }
    }

    const books = await getBooksByAuthor(authorId);
    return pickMatchingBook(books, selection);
  }

  async function findExistingBookForSelectionWithRetries(
    selection: ReadarrLookupBook,
    authorId: number,
  ) {
    const immediate = await findExistingBookForSelection(selection, authorId);
    if (immediate) {
      return immediate;
    }

    for (const delayMs of POST_ADD_LOOKUP_RETRY_DELAYS_MS) {
      await wait(delayMs);
      const retryMatch = await findExistingBookForSelection(selection, authorId);
      if (retryMatch) {
        return retryMatch;
      }
    }

    return null;
  }

  const service = {
    format,

    isConfigured() {
      return isReadarrConfigured(format);
    },

    async checkConnection() {
      if (!isReadarrConfigured(format)) {
        return {
          configured: false,
          reachable: false,
          version: null,
          message:
            format === "audiobook"
              ? "Set AUDIOBOOK_READARR_BASE_URL and AUDIOBOOK_READARR_API_KEY to enable audiobook requests."
              : "Set READARR_BASE_URL and READARR_API_KEY to enable live search.",
        };
      }

      try {
        const status = await readarrFetch<ReadarrSystemStatus>(
          format,
          "/api/v1/system/status",
        );
        return {
          configured: true,
          reachable: true,
          version: status.version ?? null,
          message:
            format === "audiobook"
              ? "Connected to the audiobook Readarr."
              : "Connected to Readarr.",
        };
      } catch (error) {
        return {
          configured: true,
          reachable: false,
          version: null,
          message:
            error instanceof Error
              ? error.message
              : "Kindling could not reach Readarr right now.",
        };
      }
    },

    async searchBooks(query: string) {
      const books = await readarrFetch<ReadarrLookupSearchBook[]>(
        format,
        "/api/v1/book/lookup",
        undefined,
        {
          term: query,
        },
      );

      return enrichLookupBooks(books);
    },

    getBook(bookId: number) {
      return readarrFetch<ReadarrLookupBook>(format, `/api/v1/book/${bookId}`);
    },

    getBooksByAuthor,

    getQueueDetails(bookIds: number[]) {
      if (bookIds.length === 0) {
        return Promise.resolve([] as ReadarrQueueItem[]);
      }

      return readarrFetch<ReadarrQueueItem[]>(format, "/api/v1/queue/details", undefined, {
        bookIds,
        includeBook: true,
      });
    },

    getBookFiles(bookId: number) {
      return readarrFetch<ReadarrBookFile[]>(format, "/api/v1/bookfile", undefined, { bookId });
    },

    deleteBookFile(bookFileId: number) {
      return readarrFetch<null>(format, `/api/v1/bookfile/${bookFileId}`, {
        method: "DELETE",
      });
    },

    getRootFolders,
    getQualityProfiles,
    getMetadataProfiles,
    resolveDefaults,

    async ensureAuthorExistsForBook(selection: ReadarrLookupBook) {
      if (selection.author.id && selection.author.id > 0) {
        return selection.author;
      }

      const defaults = await resolveDefaults();

      const payload: ReadarrAuthor = {
        ...selection.author,
        qualityProfileId: defaults.qualityProfileId,
        metadataProfileId: defaults.metadataProfileId,
        rootFolderPath: defaults.rootFolderPath,
        monitored: false,
        monitorNewItems: "none",
        addOptions: {
          monitor: "none",
          booksToMonitor: [selection.foreignBookId],
          monitored: false,
          searchForMissingBooks: false,
        },
      };

      try {
        return await readarrFetch<ReadarrAuthor>(format, "/api/v1/author", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      } catch (error) {
        const refreshedResults = await service.searchBooks(
          `${selection.title} ${selection.author.authorName}`,
        );
        const refreshedBook = pickMatchingBook(refreshedResults, selection);

        if (refreshedBook?.author.id) {
          return refreshedBook.author;
        }

        throw error;
      }
    },

    async addBookForRequest(selection: ReadarrLookupBook) {
      const defaults = await resolveDefaults();
      const author = await service.ensureAuthorExistsForBook(selection);
      const authorId = author.id ?? selection.author.id;

      if (!authorId) {
        throw new ReadarrApiError("Readarr could not determine an author for this request.", 400);
      }

      const existingBook = await findExistingBookForSelection(selection, authorId);
      if (existingBook) {
        return existingBook;
      }

      const payload: ReadarrLookupBook = {
        ...selection,
        authorId,
        monitored: true,
        anyEditionOk: selection.anyEditionOk ?? true,
        // Older Readarr builds null-deref if /api/v1/book receives a missing editions array.
        editions: selection.editions ?? [],
        author: {
          ...selection.author,
          ...author,
          id: authorId,
          qualityProfileId: author.qualityProfileId ?? defaults.qualityProfileId,
          metadataProfileId: author.metadataProfileId ?? defaults.metadataProfileId,
          rootFolderPath: author.rootFolderPath ?? defaults.rootFolderPath,
        },
        addOptions: {
          addType: "automatic",
          searchForNewBook: false,
        },
      };

      try {
        return await readarrFetch<ReadarrLookupBook>(format, "/api/v1/book", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      } catch (error) {
        const fallbackBook = await findExistingBookForSelectionWithRetries(selection, authorId);
        if (fallbackBook) {
          return fallbackBook;
        }

        throw error;
      }
    },

    monitorRequestedBook(bookId: number) {
      return readarrFetch<ReadarrLookupBook[]>(format, "/api/v1/book/monitor", {
        method: "PUT",
        body: JSON.stringify({
          bookIds: [bookId],
          monitored: true,
        }),
      });
    },

    unmonitorRequestedBook(bookId: number) {
      return readarrFetch<ReadarrLookupBook[]>(format, "/api/v1/book/monitor", {
        method: "PUT",
        body: JSON.stringify({
          bookIds: [bookId],
          monitored: false,
        }),
      });
    },

    triggerBookSearch(bookId: number) {
      return readarrFetch<{ id: number; status?: string | null }>(
        format,
        "/api/v1/command",
        {
          method: "POST",
          body: JSON.stringify({
            name: "BookSearch",
            bookIds: [bookId],
          }),
        },
      );
    },

    async getBookStatus(bookId: number) {
      const [book, queueItems] = await Promise.all([
        service.getBook(bookId),
        service.getQueueDetails([bookId]),
      ]);

      return {
        book,
        queueItems,
      };
    },
  };

  return service;
}

export type ReadarrService = ReturnType<typeof createReadarrService>;
