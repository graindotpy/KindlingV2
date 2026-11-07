import type { ReadarrLookupBook } from "@/lib/readarr/types";
import type { BookRequestFormat, SearchResultItem } from "@/lib/requests/types";

// Requests are built from the Readarr book Kindling itself returned in a recent
// search, never from the copy the browser sends back. This keeps arbitrary
// client-supplied fields out of the payload that Kindling POSTs to Readarr.
const SELECTION_TTL_MS = 30 * 60_000;
const MAX_SELECTIONS = 1_000;

type CachedSelection = {
  book: ReadarrLookupBook;
  expiresAt: number;
};

declare global {
  var __kindlingSelectionCache: Map<string, CachedSelection> | undefined;
}

function getCache() {
  globalThis.__kindlingSelectionCache ??= new Map();
  return globalThis.__kindlingSelectionCache;
}

function getKey(format: BookRequestFormat, foreignBookId: string, foreignAuthorId: string) {
  return `${format}\u0000${foreignBookId}\u0000${foreignAuthorId}`;
}

function pruneExpired(cache: Map<string, CachedSelection>, now: number) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

export function rememberSearchSelections(results: unknown, now = Date.now()) {
  if (!Array.isArray(results)) return;
  const cache = getCache();
  pruneExpired(cache, now);

  for (const result of results as Array<Partial<SearchResultItem>>) {
    for (const format of ["ebook", "audiobook"] as const) {
      const book = result?.actions?.[format]?.source;
      const foreignBookId = book?.foreignBookId;
      const foreignAuthorId = book?.author?.foreignAuthorId;
      if (!book || !foreignBookId || !foreignAuthorId) continue;

      const key = getKey(format, foreignBookId, foreignAuthorId);
      // Re-inserting keeps the Map ordered from oldest to newest use.
      cache.delete(key);
      cache.set(key, { book, expiresAt: now + SELECTION_TTL_MS });
    }
  }

  while (cache.size > MAX_SELECTIONS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function findSearchSelection(
  format: BookRequestFormat,
  foreignBookId: string,
  foreignAuthorId: string,
  now = Date.now(),
) {
  const cache = getCache();
  const key = getKey(format, foreignBookId, foreignAuthorId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return entry.book;
}

export function clearSearchSelections() {
  getCache().clear();
}
