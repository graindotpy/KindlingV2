import { getReadarrConfig, isReadarrConfigured } from "@/lib/config";
import type { BookRequestFormat } from "@/lib/requests/types";
import {
  filterAndRankBooksByTitle,
  matchesLibraryQuery,
  normalizeSearchQuery,
  rankSearchBooks,
} from "@/lib/search/query";
import type { BookTitleSearchContext } from "@/lib/search/query";
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
};

const REQUEST_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 20_000;
const RESOLVED_AUTHOR_SEARCH_TIMEOUT_MS = 10_000;
const RESOLVED_DIRECT_FALLBACK_TIMEOUT_MS = 10_000;
const MAX_SEARCH_RESULTS = 60;
const libraryCache = new WeakMap<ReturnType<typeof getReadarrConfig>, {
  expiresAt: number;
  books: Promise<ReadarrLookupBook[]>;
}>();

export type ReadarrSearchResponse = {
  books: ReadarrLookupBook[];
  warnings: string[];
  source: "metadata" | "library" | "mixed";
};

export type ReadarrAuthorBookSearch = BookTitleSearchContext & {
  authorForeignId: string;
  fallbackQuery?: string;
};
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

  // A leading slash would discard Readarr's configured URL Base (e.g. /readarr).
  const url = new URL(pathname.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`);

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

export async function readarrFetch<T>(
  format: BookRequestFormat,
  pathname: string,
  init?: RequestInit,
  query?: Record<string, QueryValue>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const config = getReadarrConfig(format);
  const apiKey = config.apiKey;

  if (!apiKey) {
    throw new ReadarrApiError(getReadarrConfigErrorMessage(format), 503);
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetch(buildUrl(format, pathname, query), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
      signal,
    });

    const payload = await parseResponseBody(response);

    if (!response.ok) {
      throw new ReadarrApiError(
        response.status === 401 || response.status === 403
          ? "Readarr rejected the API key. Check this instance's connection settings."
          : response.status === 429
            ? "Readarr's book catalogue is busy. Please try again shortly."
            : /goodreads|metadata|readarrapi|bookinfo/i.test(getErrorMessage(payload) ?? "")
              ? "Readarr's book catalogue could not be reached. Check the metadata provider in Readarr."
              : `Readarr returned an error (${response.status}). Check its logs and connection settings.`,
        response.status,
      );
    }

    if (typeof payload === "string") {
      throw new ReadarrApiError("Readarr returned an unexpected response. Check its base URL and reverse proxy settings.", 502);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof ReadarrApiError) throw error;
    if (signal.aborted) {
      throw new ReadarrApiError("Readarr took too long to respond. Please try again shortly.", 504);
    }
    throw new ReadarrApiError("Kindling could not connect to Readarr. Check that it is running and its connection settings are correct.", 503);
  } finally {
    clearTimeout(timer);
  }
}

function pickMatchingBook(books: ReadarrLookupBook[], selection: ReadarrLookupBook) {
  return books.find((book) => book.foreignBookId && book.foreignBookId === selection.foreignBookId) ?? null;
}

function hasAuthorIdentity(author: ReadarrAuthor | undefined): author is ReadarrAuthor {
  return typeof author?.authorName === "string" && Boolean(author.authorName.trim()) &&
    typeof author.foreignAuthorId === "string" && Boolean(author.foreignAuthorId.trim());
}

function hasBookIdentity(book: ReadarrLookupSearchBook): book is ReadarrLookupBook {
  return typeof book.title === "string" && Boolean(book.title.trim()) &&
    typeof book.foreignBookId === "string" && Boolean(book.foreignBookId.trim()) && hasAuthorIdentity(book.author);
}

function normalizeGoodreadsAuthorId(value: string) {
  return value.trim().match(/^(?:goodreads(?:-author)?:)?(\d+)$/i)?.[1] ?? null;
}

function hasExpectedAuthor(book: ReadarrLookupBook, authorForeignId: string) {
  return normalizeGoodreadsAuthorId(book.author.foreignAuthorId) === authorForeignId;
}

function lookupRows(payload: unknown): ReadarrLookupSearchBook[] {
  if (!Array.isArray(payload)) throw new ReadarrApiError("Readarr returned an invalid book catalogue response.", 502);
  return payload.filter((book) => book && typeof book === "object" &&
    typeof book.title === "string" && book.title.trim() && typeof book.foreignBookId === "string" && book.foreignBookId.trim());
}

function unifiedSearchRows(payload: unknown) {
  if (!Array.isArray(payload)) throw new ReadarrApiError("Readarr returned an invalid book catalogue response.", 502);
  // /search includes separate author entries; only book entries are requestable.
  return lookupRows(payload.flatMap((entry) => entry && typeof entry === "object" && entry.book ? [entry.book] : []));
}

async function mapWithConcurrency<T, R>(values: T[], callback: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await callback(values[index]);
    }
  }));
  return results;
}

// Readarr answers searches only after its metadata provider does, so a search
// timeout almost always means that provider is slow or down, not Readarr itself.
function asCatalogueTimeout(error: unknown) {
  return error instanceof ReadarrApiError && error.status === 504
    ? new ReadarrApiError(
      "Readarr took too long to search its book catalogue. Its metadata provider is probably slow or down; check Metadata Provider Source on Readarr's /settings/development page.",
      504,
    )
    : error;
}

function libraryNotice(label: string) {
  return `${label} search is showing matches from your Readarr library. New books may be missing while its book catalogue is unavailable or incomplete.`;
}

// Diagnostics about how a result was found (fallbacks, skipped rows) only matter
// when nothing was found. Once there are results, keep only the library notice,
// because that one says the list itself may be incomplete.
function warningsForResults(warnings: string[], hasResults: boolean, label: string) {
  return hasResults ? warnings.filter((warning) => warning === libraryNotice(label)) : warnings;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pickBestCoverUrl(resource: {
  remoteCover?: string | null;
  remotePoster?: string | null;
  images?: Array<{ remoteUrl?: string | null; url?: string | null }> | null;
}) {
  const candidates = [resource.remoteCover, resource.remotePoster,
    ...(resource.images?.flatMap((image) => [image.remoteUrl, image.url]) ?? [])];
  return candidates.find((url) => {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }) ?? null;
}

export function pickPreferredEditionId(book: ReadarrLookupBook) {
  const monitoredEdition = book.editions?.find((edition) => edition.monitored);
  return monitoredEdition?.id ?? book.editions?.[0]?.id ?? null;
}

export function createReadarrService(format: BookRequestFormat = "ebook") {
  let defaultsCache: { value: ReadarrDefaults; expiresAt: number; config: ReturnType<typeof getReadarrConfig> } | null = null;
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
    const config = getReadarrConfig(format);
    if (defaultsCache && defaultsCache.config === config && defaultsCache.expiresAt > Date.now()) {
      return defaultsCache.value;
    }

    const [rootFolders, qualityProfiles, metadataProfiles] = await Promise.all([
      getRootFolders(),
      getQualityProfiles(),
      getMetadataProfiles(),
    ]);

    const rootFolder = config.rootFolderPath
      ? rootFolders.find((folder) => folder.path === config.rootFolderPath)
      : rootFolders[0];
    const rootFolderPath = rootFolder?.path;
    const qualityProfileId =
      config.qualityProfileId ??
      rootFolder?.defaultQualityProfileId ??
      qualityProfiles[0]?.id;
    const metadataProfileId =
      config.metadataProfileId ??
      rootFolder?.defaultMetadataProfileId ??
      metadataProfiles[0]?.id;

    if (!rootFolderPath || !qualityProfileId || !metadataProfileId ||
      !qualityProfiles.some((profile) => profile.id === qualityProfileId) ||
      !metadataProfiles.some((profile) => profile.id === metadataProfileId)) {
      throw new ReadarrApiError(
        "Readarr is missing a usable root folder or profile configuration.",
        400,
      );
    }

    const value = {
      rootFolderPath,
      qualityProfileId,
      metadataProfileId,
    };

    defaultsCache = { value, expiresAt: Date.now() + 60_000, config };
    return value;
  }

  async function getBooksByAuthor(authorId: number) {
    return readarrFetch<ReadarrLookupBook[]>(format, "/api/v1/book", undefined, { authorId });
  }

  async function enrichLookupBooks(books: ReadarrLookupSearchBook[], signal: AbortSignal) {
    const enriched = await mapWithConcurrency(books, async (book) => {
      if (hasBookIdentity(book)) return book;
      if (signal.aborted) return null;
      // /book/lookup intentionally omits author details in upstream Readarr.
      // Author lookup accepts work IDs too, so no author-name guess is needed.
      if (!signal.aborted && /^\d+$/.test(book.foreignBookId)) {
        try {
          const payload = await readarrFetch<ReadarrAuthor[]>(format, "/api/v1/author/lookup", { signal }, {
            term: `work:${book.foreignBookId}`,
          });
          const authors = Array.isArray(payload) ? payload.filter(hasAuthorIdentity) : [];
          if (new Set(authors.map((author) => author.foreignAuthorId)).size === 1) {
            const author = authors[0];
            return { ...book, authorId: author.id, author } satisfies ReadarrLookupBook;
          }
        } catch {
          // Preserve other trustworthy rows and report the omitted ones to the caller.
        }
      }
      return null;
    });
    return enriched.filter((book): book is ReadarrLookupBook => book !== null);
  }

  async function loadLibrary() {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 5_000);
    try {
      const books = lookupRows(await readarrFetch(format, "/api/v1/book", { signal: timeout.signal }));
      let authors: ReadarrAuthor[] = [];
      if (books.some((book) => !hasAuthorIdentity(book.author))) {
        const payload = await readarrFetch<ReadarrAuthor[]>(format, "/api/v1/author", { signal: timeout.signal });
        if (Array.isArray(payload)) authors = payload;
      }
      const authorsById = new Map(authors.filter((author) => hasAuthorIdentity(author) && author.id && author.id > 0).map((author) => [author.id, author]));
      return books.map((book) => hasBookIdentity(book) ? book : {
        ...book, author: authorsById.get(book.authorId),
      }).filter(hasBookIdentity);
    } finally {
      clearTimeout(timer);
    }
  }

  async function searchLibrary(query: string) {
    const config = getReadarrConfig(format);
    let cached = libraryCache.get(config);
    if (!cached || cached.expiresAt <= Date.now()) {
      const books = loadLibrary();
      cached = { expiresAt: Date.now() + 30_000, books };
      libraryCache.set(config, cached);
      books.catch(() => {
        if (libraryCache.get(config)?.books === books) libraryCache.delete(config);
      });
    }
    return (await cached.books).filter((book) => matchesLibraryQuery(book, query));
  }

  async function searchBooksWithDiagnostics(query: string): Promise<ReadarrSearchResponse> {
    const term = normalizeSearchQuery(query);
    if (!term) return { books: [], warnings: [], source: "metadata" };
    if (term.length > 300) throw new ReadarrApiError("Please use a shorter title, author name, or ISBN.", 400);
    const label = format === "audiobook" ? "Audiobook" : "Ebook";
    const warnings: string[] = [];
    let books: ReadarrLookupBook[] = [];
    let remoteError: unknown = null;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), SEARCH_TIMEOUT_MS);
    try {
      let rows: ReadarrLookupSearchBook[] = [];
      try {
        // This is Readarr's own UI search API; it includes authors and editions.
        rows = unifiedSearchRows(await readarrFetch(format, "/api/v1/search", { signal: timeout.signal }, { term }));
      } catch (error) {
        remoteError = error;
      }
      if (rows.length === 0 && !timeout.signal.aborted) {
        rows = lookupRows(await readarrFetch(format, "/api/v1/book/lookup", { signal: timeout.signal }, { term }));
        remoteError = null;
      }
      rows = rows.slice(0, MAX_SEARCH_RESULTS);
      books = await enrichLookupBooks(rows, timeout.signal);
      if (rows.length > books.length) {
        warnings.push(`${label} search returned incomplete book details. Some results could not be safely matched to an author.`);
      }
      if (rows.length > 0 && books.length === 0) {
        remoteError = new ReadarrApiError(`${label} search could not verify book details. Check the metadata provider in Readarr.`, 502);
      }
    } catch (error) {
      remoteError = error;
    } finally {
      clearTimeout(timer);
    }

    let source: ReadarrSearchResponse["source"] = "metadata";
    if (books.length === 0 || warnings.length > 0) {
      try {
        const localBooks = await searchLibrary(term);
        if (localBooks.length > 0) {
          source = books.length ? "mixed" : "library";
          books.push(...localBooks);
          warnings.push(libraryNotice(label));
        }
      } catch {
        // Keep the metadata error when both lookup and local fallback failed.
      }
    }
    if (books.length === 0 && remoteError) throw asCatalogueTimeout(remoteError);
    if (books.length === 0) {
      // Upstream Readarr sometimes converts Goodreads/metadata errors to a successful empty list.
      warnings.push(`${label} Readarr returned no matches. Try a title, author, ISBN, or Goodreads book link; if searches keep returning nothing, check Readarr's metadata provider.`);
    }
    const uniqueBooks = new Map<string, ReadarrLookupBook>();
    for (const book of books) {
      const existing = uniqueBooks.get(book.foreignBookId);
      if (!existing || (!existing.id && book.id)) uniqueBooks.set(book.foreignBookId, book);
    }
    return {
      books: rankSearchBooks([...uniqueBooks.values()], term).slice(0, MAX_SEARCH_RESULTS),
      warnings: warningsForResults(warnings, uniqueBooks.size > 0, label),
      source,
    };
  }

  async function searchOriginalQueryForResolvedBook(
    query: string,
    titleContext: BookTitleSearchContext,
    authorForeignId: string,
  ) {
    const term = normalizeSearchQuery(query);
    const label = format === "audiobook" ? "Audiobook" : "Ebook";
    const warnings: string[] = [];
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      RESOLVED_DIRECT_FALLBACK_TIMEOUT_MS,
    );

    try {
      // This is deliberately one standard Readarr search with the user's exact
      // input. An empty response is final and does not cascade into /book/lookup.
      const rows = unifiedSearchRows(await readarrFetch(
        format,
        "/api/v1/search",
        { signal: timeout.signal },
        { term },
      ));
      const matchingRows = filterAndRankBooksByTitle(rows, titleContext);
      const enrichedBooks = await enrichLookupBooks(matchingRows, timeout.signal);
      const books = enrichedBooks.filter(
        (book) => hasExpectedAuthor(book, authorForeignId),
      );

      if (matchingRows.length > enrichedBooks.length) {
        warnings.push(`${label} search returned incomplete book details. Some matching results could not be safely verified.`);
      }
      if (enrichedBooks.length > books.length) {
        warnings.push(`${label} search returned matching titles for a different author. Those results were ignored.`);
      }

      return { books, warnings, error: null };
    } catch (error) {
      return { books: [] as ReadarrLookupBook[], warnings, error };
    } finally {
      clearTimeout(timer);
    }
  }

  async function searchBooksByAuthorWithDiagnostics(
    search: ReadarrAuthorBookSearch,
  ): Promise<ReadarrSearchResponse> {
    const authorForeignId = normalizeGoodreadsAuthorId(search.authorForeignId);
    if (!authorForeignId) {
      throw new ReadarrApiError("The selected author does not have a valid Goodreads ID.", 400);
    }

    const targetTitle = search.targetTitle.trim().replace(/\s+/g, " ");
    const alternateTitles = (search.alternateTitles ?? [])
      .map((title) => title.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    const fallbackQuery = search.fallbackQuery?.trim().replace(/\s+/g, " ") ?? "";
    if (!targetTitle) {
      throw new ReadarrApiError("The selected book does not have a usable title.", 400);
    }
    if ([targetTitle, ...alternateTitles, fallbackQuery].some((title) => title.length > 300)) {
      throw new ReadarrApiError("Please use a shorter book title.", 400);
    }

    const titleContext: BookTitleSearchContext = { targetTitle, alternateTitles };
    const lookupTerm = `author:${authorForeignId}`;
    const label = format === "audiobook" ? "Audiobook" : "Ebook";
    const warnings: string[] = [];
    let books: ReadarrLookupBook[] = [];
    let remoteError: unknown = null;
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      fallbackQuery ? RESOLVED_AUTHOR_SEARCH_TIMEOUT_MS : SEARCH_TIMEOUT_MS,
    );

    try {
      let rows: ReadarrLookupSearchBook[] = [];
      let shouldTryBookLookup = false;
      try {
        rows = unifiedSearchRows(await readarrFetch(format, "/api/v1/search", { signal: timeout.signal }, {
          term: lookupTerm,
        }));
        shouldTryBookLookup = rows.length === 0;
      } catch (error) {
        remoteError = error;
        // Older Readarr builds may not expose the unified search endpoint.
        // Other failures move directly to the user's original query rather
        // than multiplying requests to an already unhealthy metadata service.
        shouldTryBookLookup = error instanceof ReadarrApiError && error.status === 404;
      }
      if (shouldTryBookLookup && !timeout.signal.aborted) {
        rows = lookupRows(await readarrFetch(format, "/api/v1/book/lookup", { signal: timeout.signal }, {
          term: lookupTerm,
        }));
        remoteError = null;
      }

      // An author lookup can return hundreds of works. Filter the complete response
      // before enrichment or the display cap so a late matching work is not lost.
      const matchingRows = filterAndRankBooksByTitle(rows, titleContext);
      const enrichedBooks = await enrichLookupBooks(matchingRows, timeout.signal);
      books = enrichedBooks.filter((book) => hasExpectedAuthor(book, authorForeignId));

      if (matchingRows.length > enrichedBooks.length) {
        warnings.push(`${label} search returned incomplete book details. Some matching results could not be safely verified.`);
      }
      if (enrichedBooks.length > books.length) {
        warnings.push(`${label} search returned matching titles for a different author. Those results were ignored.`);
      }
    } catch (error) {
      remoteError = error;
    } finally {
      clearTimeout(timer);
    }

    let source: ReadarrSearchResponse["source"] = "metadata";
    if (books.length === 0 && fallbackQuery) {
      const fallbackNotice = `${label} Readarr did not return a verified match from the author catalogue, so Kindling used its standard search for your original query.`;
      const [fallback, localBooks] = await Promise.all([
        searchOriginalQueryForResolvedBook(
          fallbackQuery,
          titleContext,
          authorForeignId,
        ),
        searchLibrary(lookupTerm).then((libraryBooks) =>
          filterAndRankBooksByTitle(libraryBooks, titleContext)
            .filter((book) => hasExpectedAuthor(book, authorForeignId)),
        ).catch(() => [] as ReadarrLookupBook[]),
      ]);

      warnings.push(fallbackNotice, ...fallback.warnings);
      if (localBooks.length > 0) {
        books.push(...localBooks);
        source = "library";
        warnings.push(libraryNotice(label));
      }
      if (fallback.books.length > 0) {
        books.push(...fallback.books);
        source = localBooks.length > 0 ? "mixed" : "metadata";
      }

      if (fallback.error && books.length === 0) {
        remoteError = fallback.error;
      } else {
        // A completed fallback, including a clean empty response, supersedes the
        // failed author lookup. Empty really is the final result at this point.
        remoteError = null;
      }
    } else if (books.length === 0 || warnings.length > 0) {
      try {
        const localBooks = filterAndRankBooksByTitle(
          await searchLibrary(lookupTerm),
          titleContext,
        ).filter((book) => hasExpectedAuthor(book, authorForeignId));
        if (localBooks.length > 0) {
          source = books.length ? "mixed" : "library";
          books.push(...localBooks);
          warnings.push(libraryNotice(label));
        }
      } catch {
        // Keep the metadata error when both lookup and local fallback failed.
      }
    }

    if (books.length === 0 && remoteError) throw asCatalogueTimeout(remoteError);
    if (books.length === 0) {
      warnings.push(fallbackQuery
        ? `${label} Readarr returned no work matching both the selected title and author, including from its standard search.`
        : `${label} Readarr returned no matching works for the selected title. Its metadata provider may have an incomplete author catalogue.`);
    }

    const uniqueBooks = new Map<string, ReadarrLookupBook>();
    for (const book of books) {
      const existing = uniqueBooks.get(book.foreignBookId);
      if (!existing || (!existing.id && book.id)) uniqueBooks.set(book.foreignBookId, book);
    }

    const rankedBooks = filterAndRankBooksByTitle([...uniqueBooks.values()], titleContext)
      .slice(0, MAX_SEARCH_RESULTS);
    return {
      books: rankedBooks,
      warnings: warningsForResults(warnings, rankedBooks.length > 0, label),
      source,
    };
  }

  async function findExistingBookForSelection(
    selection: ReadarrLookupBook,
    authorId: number,
  ) {
    if (selection.id && selection.id > 0) {
      try {
        const book = await service.getBook(selection.id);
        if (pickMatchingBook([book], selection)) return book;
      } catch (error) {
        if (!(error instanceof ReadarrApiError) || error.status !== 404) throw error;
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

    searchBooksWithDiagnostics,

    searchBooksByAuthorWithDiagnostics,

    async searchBooksByAuthor(search: ReadarrAuthorBookSearch) {
      return (await searchBooksByAuthorWithDiagnostics(search)).books;
    },

    async searchBooks(query: string) {
      return (await searchBooksWithDiagnostics(query)).books;
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

    getRootFolders,
    getQualityProfiles,
    getMetadataProfiles,
    resolveDefaults,

    async ensureAuthorExistsForBook(selection: ReadarrLookupBook) {
      if (!hasBookIdentity(selection)) {
        throw new ReadarrApiError("This book is missing verified author details. Please search again.", 400);
      }
      const matchesSelection = (author: ReadarrAuthor | undefined) => hasAuthorIdentity(author) &&
        Number.isInteger(author.id) && (author.id ?? 0) > 0 && author.foreignAuthorId === selection.author.foreignAuthorId;
      const findLocalAuthor = async () => {
        const authors = await readarrFetch<ReadarrAuthor[]>(format, "/api/v1/author");
        if (!Array.isArray(authors)) throw new ReadarrApiError("Readarr returned an invalid author response.", 502);
        return authors.find(matchesSelection);
      };
      if (selection.author.id && selection.author.id > 0) {
        try {
          const author = await readarrFetch<ReadarrAuthor>(format, `/api/v1/author/${selection.author.id}`);
          if (matchesSelection(author)) return author;
        } catch (error) {
          if (!(error instanceof ReadarrApiError) || error.status !== 404) throw error;
        }
      }

      const existingAuthor = await findLocalAuthor();
      if (existingAuthor) return existingAuthor;

      const defaults = await resolveDefaults();

      const payload: ReadarrAuthor = {
        ...selection.author,
        id: 0,
        path: undefined,
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
        const author = await readarrFetch<ReadarrAuthor>(format, "/api/v1/author", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        libraryCache.delete(getReadarrConfig(format));
        if (!matchesSelection(author)) throw new ReadarrApiError("Readarr could not verify the author for this request.", 502);
        return author;
      } catch (error) {
        // An author can be created even when Readarr's refresh returns an error.
        try {
          const recovered = await findLocalAuthor();
          if (recovered) {
            libraryCache.delete(getReadarrConfig(format));
            return recovered;
          }
        } catch {
          // Report the original add failure if recovery also fails.
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
        id: 0,
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
        const added = await readarrFetch<ReadarrLookupBook>(format, "/api/v1/book", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        libraryCache.delete(getReadarrConfig(format));
        if (!added?.id || !pickMatchingBook([added], selection)) {
          throw new ReadarrApiError("Readarr could not verify the book added for this request.", 502);
        }
        return added;
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

type FullReadarrService = ReturnType<typeof createReadarrService>;
type OptionalSearchMethod =
  | "searchBooksWithDiagnostics"
  | "searchBooksByAuthorWithDiagnostics"
  | "searchBooksByAuthor";
export type ReadarrService = Omit<FullReadarrService, OptionalSearchMethod> &
  Partial<Pick<FullReadarrService, OptionalSearchMethod>>;
