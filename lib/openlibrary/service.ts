import { setDefaultResultOrder } from "node:dns";
import { z } from "zod";
import { getAppConfig } from "@/lib/config";
import type {
  OpenLibraryAuthorCandidate,
  OpenLibraryAuthorRef,
  OpenLibraryBookCandidate,
  OpenLibraryRequestOptions,
} from "@/lib/openlibrary/types";

const OPEN_LIBRARY_ORIGIN = "https://openlibrary.org";
const SEARCH_RESULT_LIMIT = 8;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REQUEST_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;
const MAX_RESPONSE_BYTES = 512 * 1024;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 64;
const ANONYMOUS_REQUEST_INTERVAL_MS = 1_000;

const workKeySchema = z.string().regex(/^(?:\/works\/)?OL\d+W$/i);
const authorKeySchema = z.string().regex(/^(?:\/authors\/)?OL\d+A$/i);

const searchResponseSchema = z.object({
  docs: z.array(z.unknown()).max(100),
});

const bookSearchDocumentSchema = z.object({
  key: workKeySchema,
  title: z.string().trim().min(1).max(1_000),
  author_key: z.array(authorKeySchema).max(100).optional(),
  author_name: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  first_publish_year: z.number().int().min(-10_000).max(3_000).optional(),
  cover_i: z.number().int().positive().optional(),
});

const authorSearchDocumentSchema = z.object({
  key: authorKeySchema,
  name: z.string().trim().min(1).max(500),
  top_work: z.string().trim().min(1).max(1_000).optional(),
  work_count: z.number().int().nonnegative().optional(),
});

const authorResponseSchema = z.object({
  key: authorKeySchema,
  remote_ids: z.object({
    goodreads: z.union([
      z.string().regex(/^\d+$/),
      z.number().int().positive().safe(),
    ]).optional(),
  }).optional(),
});

type CacheEntry = {
  expiresAt: number;
  promise: Promise<unknown>;
};

type OpenLibraryEndpoint = "book-search" | "author-search" | "author-detail";

type OpenLibraryApiErrorOptions = {
  diagnosticCode?: string;
  retryable?: boolean;
};

const responseCache = new Map<string, CacheEntry>();
let anonymousRequestQueue = Promise.resolve();
let nextAnonymousRequestAt = 0;

export class OpenLibraryApiError extends Error {
  status: number;
  diagnosticCode: string;
  retryable: boolean;
  reported = false;

  constructor(
    message: string,
    status: number,
    options: OpenLibraryApiErrorOptions = {},
  ) {
    super(message);
    this.name = "OpenLibraryApiError";
    this.status = status;
    this.diagnosticCode = options.diagnosticCode ?? "request-error";
    this.retryable = options.retryable ?? false;
  }
}

function normalizeWorkKey(value: string) {
  return value.replace(/^\/works\//i, "").toUpperCase();
}

function normalizeAuthorKey(value: string) {
  return value.replace(/^\/authors\//i, "").toUpperCase();
}

function normalizeTextQuery(value: string, description: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || normalized.length > 300) {
    throw new OpenLibraryApiError(`Please enter a valid ${description}.`, 400);
  }
  return normalized;
}

function normalizeIsbn(value: string) {
  const normalized = value.trim().replace(/^(?:isbn(?:-1[03])?:?\s*)/i, "")
    .replace(/[\s-]/g, "").toUpperCase();
  if (!/^(?:\d{9}[\dX]|\d{13})$/.test(normalized)) {
    throw new OpenLibraryApiError("Please enter a valid ISBN-10 or ISBN-13.", 400);
  }
  return normalized;
}

function buildUserAgent() {
  const email = getAppConfig().openLibrary.contactEmail;
  return email ? `Kindling/0.1 (${email})` : "Kindling/0.1";
}

function waitForAnonymousRateLimit() {
  if (getAppConfig().openLibrary.contactEmail) return null;

  const turn = anonymousRequestQueue.then(async () => {
    const waitMs = Math.max(0, nextAnonymousRequestAt - Date.now());
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    nextAnonymousRequestAt = Date.now() + ANONYMOUS_REQUEST_INTERVAL_MS;
  });
  anonymousRequestQueue = turn.catch(() => undefined);
  return turn;
}

function createUrl(pathname: string, query?: Record<string, string>) {
  const url = new URL(pathname, OPEN_LIBRARY_ORIGIN);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

function trimCache(now: number) {
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) {
      responseCache.delete(key);
    }
  }

  while (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    responseCache.delete(oldestKey);
  }
}

function logOpenLibraryFailure(
  endpoint: OpenLibraryEndpoint,
  error: OpenLibraryApiError,
  attempt: number,
  retrying: boolean,
  elapsedMs: number,
) {
  error.reported = true;
  const outcome = retrying
    ? `attempt ${attempt}/${MAX_REQUEST_ATTEMPTS} failed; retrying`
    : `failed after ${attempt} attempt${attempt === 1 ? "" : "s"}`;
  console.warn(
    `[kindling] Open Library ${endpoint} ${outcome} ` +
    `(${error.diagnosticCode}, status=${error.status}, elapsed=${elapsedMs}ms).`,
  );
}

function loadCached<T>(
  key: string,
  endpoint: OpenLibraryEndpoint,
  load: () => Promise<T>,
) {
  const now = Date.now();
  const existing = responseCache.get(key);
  if (existing && existing.expiresAt > now) {
    // Refresh insertion order so the fixed-size map behaves as a small LRU cache.
    responseCache.delete(key);
    responseCache.set(key, existing);
    return existing.promise as Promise<T>;
  }

  if (existing) responseCache.delete(key);
  trimCache(now);

  const entry: CacheEntry = {
    expiresAt: now + CACHE_TTL_MS,
    promise: Promise.resolve(undefined),
  };
  entry.promise = load().then((value) => {
    if (responseCache.get(key) === entry) {
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
    }
    return value;
  }).catch((error: unknown) => {
    if (responseCache.get(key) === entry) responseCache.delete(key);
    if (error instanceof OpenLibraryApiError && !error.reported) {
      logOpenLibraryFailure(endpoint, error, 1, false, 0);
    }
    throw error;
  });
  responseCache.set(key, entry);
  return entry.promise as Promise<T>;
}

function withCallerSignal<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new OpenLibraryApiError("The book metadata lookup was cancelled.", 499));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(
      new OpenLibraryApiError("The book metadata lookup was cancelled.", 499),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function getSafeNetworkDiagnosticCode(error: unknown) {
  const directCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: unknown }).cause
    : null;
  const causeCode = cause && typeof cause === "object" && "code" in cause
    ? (cause as { code?: unknown }).code
    : null;
  const code = typeof causeCode === "string"
    ? causeCode.toUpperCase()
    : typeof directCode === "string"
      ? directCode.toUpperCase()
      : "";
  const allowedCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  return allowedCodes.has(code) ? code.toLowerCase() : "network-error";
}

function getEndpoint(pathname: string): OpenLibraryEndpoint {
  if (pathname === "/search/authors.json") return "author-search";
  if (pathname.startsWith("/authors/")) return "author-detail";
  return "book-search";
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function openLibraryFetchAttempt(pathname: string, query?: Record<string, string>) {
  // Some Docker hosts advertise an IPv6 route that cannot complete TLS requests.
  // Prefer IPv4 when both families are available without disabling IPv6-only hosts.
  setDefaultResultOrder("ipv4first");
  const rateLimitTurn = waitForAnonymousRateLimit();
  if (rateLimitTurn) await rateLimitTurn;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(createUrl(pathname, query), {
      headers: {
        Accept: "application/json",
        "User-Agent": buildUserAgent(),
      },
      cache: "no-store",
      redirect: "error",
      signal: timeout.signal,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404) {
        throw new OpenLibraryApiError(
          "Open Library could not find that record.",
          404,
          { diagnosticCode: "http-404" },
        );
      }
      if (response.status === 429) {
        throw new OpenLibraryApiError(
          "Open Library is busy. Please try again shortly.",
          503,
          { diagnosticCode: "http-429", retryable: true },
        );
      }
      throw new OpenLibraryApiError(
        "Open Library could not provide book metadata. Please try again shortly.",
        502,
        {
          diagnosticCode: `http-${response.status}`,
          retryable: response.status === 408 || response.status === 425 || response.status >= 500,
        },
      );
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new OpenLibraryApiError(
        "Open Library returned an unexpected response.",
        502,
        { diagnosticCode: "response-too-large" },
      );
    }

    const text = await response.text();
    if (!text || text.length > MAX_RESPONSE_BYTES) {
      throw new OpenLibraryApiError(
        "Open Library returned an unexpected response.",
        502,
        { diagnosticCode: "invalid-response-size" },
      );
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OpenLibraryApiError(
        "Open Library returned an unexpected response.",
        502,
        { diagnosticCode: "invalid-json" },
      );
    }
  } catch (error) {
    if (error instanceof OpenLibraryApiError) throw error;
    if (timeout.signal.aborted) {
      throw new OpenLibraryApiError(
        "Open Library took too long to respond. Please try again shortly.",
        504,
        { diagnosticCode: "timeout", retryable: true },
      );
    }
    throw new OpenLibraryApiError(
      "Kindling could not connect to Open Library. Please try again shortly.",
      503,
      { diagnosticCode: getSafeNetworkDiagnosticCode(error), retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function openLibraryFetch(pathname: string, query?: Record<string, string>) {
  const endpoint = getEndpoint(pathname);
  const startedAt = Date.now();
  let lastError: OpenLibraryApiError | null = null;

  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await openLibraryFetchAttempt(pathname, query);
    } catch (error) {
      const failure = error instanceof OpenLibraryApiError
        ? error
        : new OpenLibraryApiError(
          "Kindling could not connect to Open Library. Please try again shortly.",
          503,
          { diagnosticCode: getSafeNetworkDiagnosticCode(error), retryable: true },
        );
      lastError = failure;
      const retrying = failure.retryable && attempt < MAX_REQUEST_ATTEMPTS;
      logOpenLibraryFailure(endpoint, failure, attempt, retrying, Date.now() - startedAt);
      if (!retrying) throw failure;
      await wait(RETRY_DELAY_MS);
    }
  }

  throw lastError ?? new OpenLibraryApiError(
    "Kindling could not connect to Open Library. Please try again shortly.",
    503,
    { diagnosticCode: "network-error" },
  );
}

function parseBookCandidates(payload: unknown): OpenLibraryBookCandidate[] {
  const parsed = searchResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new OpenLibraryApiError(
      "Open Library returned an unexpected book response.",
      502,
      { diagnosticCode: "invalid-book-payload" },
    );
  }

  const documents = parsed.data.docs.flatMap((value) => {
    const document = bookSearchDocumentSchema.safeParse(value);
    return document.success ? [document.data] : [];
  });
  if (parsed.data.docs.length > 0 && documents.length === 0) {
    throw new OpenLibraryApiError(
      "Open Library returned an unexpected book response.",
      502,
      { diagnosticCode: "invalid-book-payload" },
    );
  }
  if (documents.length < parsed.data.docs.length) {
    console.warn(
      `[kindling] Open Library book-search ignored ${
        parsed.data.docs.length - documents.length
      } malformed result(s).`,
    );
  }

  return documents.slice(0, SEARCH_RESULT_LIMIT).flatMap((doc) => {
    const authorKeys = doc.author_key ?? [];
    const authorNames = doc.author_name ?? [];
    const authors: OpenLibraryAuthorRef[] = authorKeys.flatMap((key, index) => {
      const name = authorNames[index];
      return name ? [{ key: normalizeAuthorKey(key), name }] : [];
    });
    if (authors.length === 0) return [];

    return [{
      key: normalizeWorkKey(doc.key),
      title: doc.title,
      authors,
      firstPublishYear: doc.first_publish_year ?? null,
      coverUrl: doc.cover_i
        ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
        : null,
    }];
  });
}

function parseAuthorCandidates(payload: unknown): OpenLibraryAuthorCandidate[] {
  const parsed = searchResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new OpenLibraryApiError(
      "Open Library returned an unexpected author response.",
      502,
      { diagnosticCode: "invalid-author-search-payload" },
    );
  }

  const documents = parsed.data.docs.flatMap((value) => {
    const document = authorSearchDocumentSchema.safeParse(value);
    return document.success ? [document.data] : [];
  });
  if (parsed.data.docs.length > 0 && documents.length === 0) {
    throw new OpenLibraryApiError(
      "Open Library returned an unexpected author response.",
      502,
      { diagnosticCode: "invalid-author-search-payload" },
    );
  }
  if (documents.length < parsed.data.docs.length) {
    console.warn(
      `[kindling] Open Library author-search ignored ${
        parsed.data.docs.length - documents.length
      } malformed result(s).`,
    );
  }

  return documents.slice(0, SEARCH_RESULT_LIMIT).map((doc) => ({
    key: normalizeAuthorKey(doc.key),
    name: doc.name,
    topWork: doc.top_work ?? null,
    workCount: doc.work_count ?? null,
  }));
}

export function createOpenLibraryService() {
  async function searchBookCandidates(
    title: string,
    options: OpenLibraryRequestOptions = {},
  ) {
    const normalized = normalizeTextQuery(title, "book title");
    const cacheKey = `book-title:${normalized.toLowerCase()}`;
    const request = loadCached(cacheKey, "book-search", async () => parseBookCandidates(
      await openLibraryFetch("/search.json", {
        title: normalized,
        fields: "key,title,author_key,author_name,first_publish_year,cover_i",
        limit: String(SEARCH_RESULT_LIMIT),
      }),
    ));
    return withCallerSignal(request, options.signal);
  }

  async function searchIsbnCandidates(
    isbn: string,
    options: OpenLibraryRequestOptions = {},
  ) {
    const normalized = normalizeIsbn(isbn);
    const request = loadCached(
      `book-isbn:${normalized}`,
      "book-search",
      async () => parseBookCandidates(
        await openLibraryFetch("/search.json", {
          isbn: normalized,
          fields: "key,title,author_key,author_name,first_publish_year,cover_i",
          limit: String(SEARCH_RESULT_LIMIT),
        }),
      ),
    );
    return withCallerSignal(request, options.signal);
  }

  async function searchAuthorCandidates(
    name: string,
    options: OpenLibraryRequestOptions = {},
  ) {
    const normalized = normalizeTextQuery(name, "author name");
    const cacheKey = `author-name:${normalized.toLowerCase()}`;
    const request = loadCached(cacheKey, "author-search", async () => parseAuthorCandidates(
      await openLibraryFetch("/search/authors.json", {
        q: normalized,
        limit: String(SEARCH_RESULT_LIMIT),
      }),
    ));
    return withCallerSignal(request, options.signal);
  }

  async function getGoodreadsAuthorId(
    authorKey: string,
    options: OpenLibraryRequestOptions = {},
  ) {
    if (!authorKeySchema.safeParse(authorKey).success) {
      throw new OpenLibraryApiError("Please select a valid Open Library author.", 400);
    }
    const normalized = normalizeAuthorKey(authorKey);
    const request = loadCached(`author-detail:${normalized}`, "author-detail", async () => {
      const parsed = authorResponseSchema.safeParse(
        await openLibraryFetch(`/authors/${normalized}.json`),
      );
      if (!parsed.success || normalizeAuthorKey(parsed.data.key) !== normalized) {
        throw new OpenLibraryApiError(
          "Open Library returned an unexpected author response.",
          502,
          { diagnosticCode: "invalid-author-detail-payload" },
        );
      }
      const goodreads = parsed.data.remote_ids?.goodreads;
      return goodreads === undefined ? null : String(goodreads);
    });
    return withCallerSignal(request, options.signal);
  }

  return {
    searchBookCandidates,
    searchIsbnCandidates,
    searchAuthorCandidates,
    getGoodreadsAuthorId,
  };
}

export function resetOpenLibraryCache() {
  responseCache.clear();
  anonymousRequestQueue = Promise.resolve();
  nextAnonymousRequestAt = 0;
}

export type OpenLibraryService = ReturnType<typeof createOpenLibraryService>;
