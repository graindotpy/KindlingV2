import { createOpenLibraryService } from "@/lib/openlibrary/service";
import type {
  OpenLibraryAuthorCandidate,
  OpenLibraryBookCandidate,
} from "@/lib/openlibrary/types";
import type { SearchCandidate } from "@/lib/requests/types";
import { normalizeSearchQuery, normalizeSearchText } from "@/lib/search/query";

const MAX_CANDIDATES = 8;
const MAX_SAME_NAME_AUTHORS = 1;
const MAX_CREDITED_AUTHORS = 2;

type OpenLibraryService = ReturnType<typeof createOpenLibraryService>;

export type ResolvedSearch =
  | {
      state: "choose";
      candidates: SearchCandidate[];
      warnings: string[];
    }
  | {
      state: "search";
      readarrQuery: string;
      bookMatch: {
        authorForeignId: string;
        targetTitle: string;
        alternateTitles: string[];
        fallbackQuery: string;
      } | null;
      warnings: string[];
    };

export class SearchResolutionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SearchResolutionError";
    this.status = status;
  }
}

function isDirectReadarrQuery(query: string) {
  return /^(?:author|work|edition|asin):/i.test(normalizeSearchQuery(query));
}

function isIsbnQuery(query: string) {
  return normalizeSearchQuery(query).match(/^isbn:(.+)$/i)?.[1] ?? null;
}

function isExactTitle(candidate: OpenLibraryBookCandidate, query: string) {
  return normalizeSearchText(candidate.title) === normalizeSearchText(query);
}

function toPublicCandidate(candidate: OpenLibraryBookCandidate): SearchCandidate {
  return {
    key: candidate.key,
    title: candidate.title,
    author: candidate.authors.map((author) => author.name).join(" & ") || "Unknown author",
    year: candidate.firstPublishYear,
    coverUrl: candidate.coverUrl,
  };
}

function directFallback(query: string, warning: string): ResolvedSearch {
  return {
    state: "search",
    readarrQuery: query,
    bookMatch: null,
    warnings: [warning],
  };
}

async function findGoodreadsAuthor(
  openLibrary: OpenLibraryService,
  authors: Array<{ key: string }>,
  signal?: AbortSignal,
) {
  let providerFailed = false;

  for (const author of authors.slice(0, MAX_CREDITED_AUTHORS)) {
    try {
      const goodreadsId = await openLibrary.getGoodreadsAuthorId(author.key, { signal });
      if (goodreadsId) {
        return { goodreadsId, providerFailed };
      }
    } catch {
      providerFailed = true;
    }
  }

  return { goodreadsId: null, providerFailed };
}

async function resolveAuthorOnlySearch(
  openLibrary: OpenLibraryService,
  query: string,
  signal?: AbortSignal,
): Promise<ResolvedSearch | null> {
  const authors = await openLibrary.searchAuthorCandidates(query, { signal });
  const target = normalizeSearchText(query);
  const exactAuthors = authors.filter(
    (author: OpenLibraryAuthorCandidate) => normalizeSearchText(author.name) === target,
  );

  for (const author of exactAuthors.slice(0, MAX_SAME_NAME_AUTHORS)) {
    const { goodreadsId } = await findGoodreadsAuthor(openLibrary, [author], signal);
    if (goodreadsId) {
      return {
        state: "search",
        readarrQuery: `author:${goodreadsId}`,
        bookMatch: null,
        warnings: [],
      };
    }
  }

  return null;
}

export function createSearchResolver(
  openLibrary: OpenLibraryService = createOpenLibraryService(),
) {
  return {
    async resolve(
      query: string,
      candidateKey?: string,
      options: { signal?: AbortSignal } = {},
    ): Promise<ResolvedSearch> {
      const trimmedQuery = query.trim();
      if (isDirectReadarrQuery(trimmedQuery)) {
        return {
          state: "search",
          readarrQuery: normalizeSearchQuery(trimmedQuery),
          bookMatch: null,
          warnings: [],
        };
      }

      const isbn = isIsbnQuery(trimmedQuery);
      let books: OpenLibraryBookCandidate[];
      try {
        books = isbn
          ? await openLibrary.searchIsbnCandidates(isbn, { signal: options.signal })
          : await openLibrary.searchBookCandidates(trimmedQuery, { signal: options.signal });
      } catch {
        return directFallback(
          trimmedQuery,
          "Open Library is unavailable, so Kindling used Readarr's standard search instead.",
        );
      }

      const exactBooks = isbn ? books : books.filter((book) => isExactTitle(book, trimmedQuery));
      const choices = (exactBooks.length > 0 ? exactBooks : books).slice(0, MAX_CANDIDATES);
      let selected: OpenLibraryBookCandidate | undefined;

      if (candidateKey) {
        selected = choices.find((book) => book.key === candidateKey);
        if (!selected) {
          throw new SearchResolutionError(
            "That Open Library suggestion no longer matches this search. Please search again.",
          );
        }
      } else if (exactBooks.length === 1 || (isbn && choices.length === 1)) {
        selected = choices[0];
      } else if (exactBooks.length > 1 || (isbn && choices.length > 0)) {
        return {
          state: "choose",
          candidates: choices.map(toPublicCandidate),
          warnings: [],
        };
      }

      if (!selected && !isbn) {
        try {
          const authorSearch = await resolveAuthorOnlySearch(
            openLibrary,
            trimmedQuery,
            options.signal,
          );
          if (authorSearch) {
            return authorSearch;
          }
        } catch {
          if (choices.length === 0) {
            return directFallback(
              trimmedQuery,
              "Open Library could not resolve that author, so Kindling used Readarr's standard search instead.",
            );
          }
        }
      }

      if (!selected && choices.length > 0) {
        return {
          state: "choose",
          candidates: choices.map(toPublicCandidate),
          warnings: [],
        };
      }

      if (!selected) {
        return directFallback(
          trimmedQuery,
          "Open Library could not identify that book, so Kindling used Readarr's standard search instead.",
        );
      }

      const authorResult = await findGoodreadsAuthor(
        openLibrary,
        selected.authors,
        options.signal,
      );
      if (!authorResult.goodreadsId) {
        return directFallback(
          trimmedQuery,
          authorResult.providerFailed
            ? "Open Library could not retrieve the selected author's identifiers, so Kindling used Readarr's standard search instead."
            : "Open Library has no Goodreads identifier for that author, so Kindling used Readarr's standard search instead.",
        );
      }

      return {
        state: "search",
        readarrQuery: `author:${authorResult.goodreadsId}`,
        bookMatch: {
          authorForeignId: authorResult.goodreadsId,
          targetTitle: selected.title,
          alternateTitles: isbn ? [] : [trimmedQuery],
          fallbackQuery: trimmedQuery,
        },
        warnings: [],
      };
    },
  };
}

export type SearchResolver = ReturnType<typeof createSearchResolver>;
