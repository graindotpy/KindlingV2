import type { ReadarrLookupBook } from "@/lib/readarr/types";

function normalizeSegment(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildRequestFingerprint(input: {
  title: string;
  author: string;
  year?: number | null;
  foreignBookId?: string | null;
}) {
  if (input.foreignBookId) {
    return `book:${input.foreignBookId.toLowerCase()}`;
  }

  const year = input.year ? `:${input.year}` : "";
  return `manual:${normalizeSegment(input.title)}:${normalizeSegment(input.author)}${year}`;
}

export function buildFingerprintFromLookupBook(selection: ReadarrLookupBook) {
  return buildRequestFingerprint({
    title: selection.title,
    author: selection.author.authorName,
    year: extractYear(selection.releaseDate),
    foreignBookId: selection.foreignBookId,
  });
}

export function extractYear(dateValue?: string | null) {
  if (!dateValue) {
    return null;
  }

  const year = new Date(dateValue).getUTCFullYear();
  return Number.isNaN(year) ? null : year;
}
