import type { ReadarrLookupBook } from "@/lib/readarr/types";

export type BookTitleMatchKind =
  | "exact"
  | "parenthetical"
  | "base"
  | "subtitle"
  | "provider-artifact"
  | "none";

export type BookTitleSearchContext = {
  targetTitle: string;
  alternateTitles?: readonly string[];
};

export function normalizeSearchText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function stripParentheticalText(value: string) {
  let stripped = value;
  let previous: string;

  // Repeating the replacement also handles nested parentheticals without making
  // title matching depend on a particular bracket depth.
  do {
    previous = stripped;
    stripped = stripped.replace(/\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}/gu, " ");
  } while (stripped !== previous);

  return stripped.trim().replace(/\s+/g, " ");
}

function describeBookTitle(value: string) {
  const withoutParenthetical = stripParentheticalText(value);
  const subtitle = withoutParenthetical.match(/^(.+?)(?::|[\u2013\u2014]|\s-\s)(.+)$/u);

  return {
    exact: normalizeSearchText(value),
    withoutParenthetical: normalizeSearchText(withoutParenthetical),
    base: normalizeSearchText(subtitle?.[1] ?? withoutParenthetical),
    hasSubtitle: Boolean(subtitle?.[2]?.trim()),
  };
}

function repairProviderArtifactTitle(value: string) {
  const withoutParenthetical = stripParentheticalText(value);
  // Some provider editions collapse CamelCase words and append a numbered
  // print-description suffix. Keep this deliberately narrower than fuzzy or
  // fully space-insensitive matching so unrelated titles cannot collide.
  const withJoinedWordsSplit = withoutParenthetical.replace(
    /([\p{Ll}\p{N}])(?=\p{Lu})/gu,
    "$1 ",
  );

  return normalizeSearchText(withJoinedWordsSplit).replace(
    /\s+\d{1,2}(?:st|nd|rd|th)?\s+edition(?:\s+text\s+only)?$/u,
    "",
  );
}

export function getBookTitleMatchKind(
  candidateTitle: string,
  targetTitle: string,
): BookTitleMatchKind {
  const candidate = describeBookTitle(candidateTitle);
  const target = describeBookTitle(targetTitle);

  if (!candidate.exact || !target.exact) return "none";
  if (candidate.exact === target.exact) return "exact";
  if (candidate.withoutParenthetical === target.withoutParenthetical) {
    return "parenthetical";
  }
  if (target.hasSubtitle && candidate.withoutParenthetical === target.base) {
    return "base";
  }
  if (candidate.hasSubtitle && candidate.base === target.withoutParenthetical) {
    return "subtitle";
  }
  if (
    repairProviderArtifactTitle(candidateTitle) === target.withoutParenthetical
  ) {
    return "provider-artifact";
  }
  return "none";
}

const TITLE_MATCH_SCORES: Record<BookTitleMatchKind, number> = {
  exact: 5,
  parenthetical: 4,
  base: 3,
  subtitle: 2,
  "provider-artifact": 1,
  none: 0,
};

export function filterAndRankBooksByTitle<T extends { title: string }>(
  books: readonly T[],
  context: BookTitleSearchContext,
) {
  const targets = [context.targetTitle, ...(context.alternateTitles ?? [])]
    .filter((title, index, values) => {
      const normalized = normalizeSearchText(title);
      return Boolean(normalized) && values.findIndex(
        (candidate) => normalizeSearchText(candidate) === normalized,
      ) === index;
    });

  return books.map((book, index) => {
    const score = targets.reduce((best, target, targetIndex) => {
      const matchScore = TITLE_MATCH_SCORES[getBookTitleMatchKind(book.title, target)];
      return Math.max(best, matchScore ? matchScore * 100 - targetIndex : 0);
    }, 0);
    return { book, index, score };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ book }) => book);
}

// Readarr uses Goodreads work IDs for books and edition IDs for /book/show URLs.
export function normalizeSearchQuery(query: string) {
  const trimmed = query.trim().replace(/\s+/g, " ");
  const goodreads = trimmed.match(/^https?:\/\/(?:(?:www|m)\.)?goodreads\.com\/(book\/show|work\/(?:editions|show)|author\/show)\/(\d+)(?=[./?#_-]|$)/i);
  if (goodreads) {
    const path = goodreads[1].toLowerCase();
    const prefix = path.startsWith("book/") ? "edition"
      : path.startsWith("author/") ? "author" : "work";
    return `${prefix}:${goodreads[2]}`;
  }
  const isbn = trimmed.replace(/^(?:isbn(?:-1[03])?:?\s*)/i, "").replace(/[\s-]/g, "");
  if (/^(?:\d{9}[\dX]|\d{13})$/i.test(isbn)) {
    return `isbn:${isbn.toUpperCase()}`;
  }
  const identifier = trimmed.match(/^(work|edition|author|asin):\s*(\S+)$/i);
  if (identifier) return `${identifier[1].toLowerCase()}:${identifier[2]}`;
  return trimmed;
}

export function matchesLibraryQuery(book: ReadarrLookupBook, query: string) {
  const identifier = query.match(/^(work|edition|author|isbn|asin):(.+)$/i);
  if (identifier) {
    const [, prefix, id] = identifier;
    switch (prefix.toLowerCase()) {
      case "work": return book.foreignBookId === id;
      case "author": return book.author.foreignAuthorId === id;
      case "edition": return book.foreignEditionId === id || Boolean(book.editions?.some((edition) => edition.foreignEditionId === id));
      case "isbn": return Boolean(book.editions?.some((edition) => [edition.isbn13, edition.isbn]
        .some((value) => value?.replace(/[\s-]/g, "").toUpperCase() === id.toUpperCase())));
      case "asin": return Boolean(book.editions?.some((edition) => edition.asin?.toLowerCase() === id.toLowerCase()));
    }
  }
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  const text = normalizeSearchText(`${book.title} ${book.author.authorName}`);
  return tokens.length > 0 && tokens.every((token) => text.includes(token));
}

export function rankSearchBooks(books: ReadarrLookupBook[], query: string) {
  const target = normalizeSearchText(query);
  const tokens = target.split(" ").filter(Boolean);
  function score(book: ReadarrLookupBook) {
    const title = normalizeSearchText(book.title);
    const author = normalizeSearchText(book.author.authorName);
    if (title === target) return 1_000;
    if (author === target) return 900;
    const text = `${title} ${author}`;
    return (title.startsWith(target) ? 200 : 0) + (text.includes(target) ? 100 : 0)
      + tokens.filter((token) => text.includes(token)).length * 10;
  }
  return books.map((book) => ({ book, score: score(book) }))
    .sort((left, right) => right.score - left.score).map(({ book }) => book);
}
