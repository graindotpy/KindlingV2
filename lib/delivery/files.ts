import fs from "node:fs/promises";
import path from "node:path";
import type { BookRequestRecord } from "@/lib/requests/types";

const SUPPORTED_EXTENSIONS = new Set([".epub", ".mobi", ".azw", ".azw3", ".pdf"]);
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export type WatchedBookFile = {
  path: string;
  basename: string;
  normalizedPath: string;
  normalizedBasename: string;
};

export type FileMatchConfidence = "exact" | "candidate" | "ambiguous" | "none";

type ScoredFileMatch = {
  file: WatchedBookFile;
  score: number;
  exactTitle: boolean;
  exactAuthor: boolean;
  basenameTitle: boolean;
  basenameAuthor: boolean;
};

export type FileMatchResult = {
  file: WatchedBookFile | null;
  confidence: FileMatchConfidence;
  automaticSendSafe: boolean;
  message: string | null;
};

export function normalizeForMatching(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value: string) {
  return normalizeForMatching(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

async function walkDirectory(rootDir: string, collected: WatchedBookFile[]) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      await walkDirectory(absolutePath, collected);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      continue;
    }

    collected.push({
      path: absolutePath,
      basename: entry.name,
      normalizedPath: normalizeForMatching(absolutePath),
      normalizedBasename: normalizeForMatching(entry.name),
    });
  }
}

export async function scanWatchDirectory(rootDir: string) {
  const collected: WatchedBookFile[] = [];

  try {
    await walkDirectory(rootDir, collected);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return [] as WatchedBookFile[];
    }

    throw error;
  }

  return collected;
}

function scoreFileMatch(file: WatchedBookFile, request: BookRequestRecord): ScoredFileMatch | null {
  const title = normalizeForMatching(request.requestedTitle);
  const author = normalizeForMatching(request.requestedAuthor);
  const titleTokens = tokenize(request.requestedTitle);
  const authorTokens = tokenize(request.requestedAuthor);

  const pathValue = `${file.normalizedBasename} ${file.normalizedPath}`;
  const exactTitle = title ? pathValue.includes(title) : false;
  const exactAuthor = author ? pathValue.includes(author) : false;
  const basenameTitle = title ? file.normalizedBasename.includes(title) : false;
  const basenameAuthor = author ? file.normalizedBasename.includes(author) : false;
  const matchedTitleTokens = titleTokens.filter((token) => pathValue.includes(token)).length;
  const matchedAuthorTokens = authorTokens.filter((token) => pathValue.includes(token)).length;

  const hasTitleMatch =
    exactTitle ||
    (titleTokens.length > 0 && matchedTitleTokens >= Math.min(titleTokens.length, 3));
  const hasAuthorMatch =
    !author ||
    exactAuthor ||
    (authorTokens.length > 0 && matchedAuthorTokens >= Math.min(authorTokens.length, 2));

  if (!hasTitleMatch || !hasAuthorMatch) {
    return null;
  }

  return {
    file,
    score: [
      exactTitle ? 20 : 0,
      exactAuthor ? 10 : 0,
      basenameTitle ? 6 : 0,
      basenameAuthor ? 3 : 0,
      matchedTitleTokens * 3,
      matchedAuthorTokens * 2,
    ].reduce((sum, value) => sum + value, 0),
    exactTitle,
    exactAuthor,
    basenameTitle,
    basenameAuthor,
  };
}

function getCandidateMatches(request: BookRequestRecord, files: WatchedBookFile[]) {
  return files
    .map((file) => scoreFileMatch(file, request))
    .filter((match): match is ScoredFileMatch => Boolean(match))
    .sort((left, right) => right.score - left.score);
}

export function findFileMatch(
  request: BookRequestRecord,
  files: WatchedBookFile[],
): FileMatchResult {
  const candidates = getCandidateMatches(request, files);
  const top = candidates[0];

  if (!top) {
    return {
      file: null,
      confidence: "none",
      automaticSendSafe: false,
      message: null,
    };
  }

  const exactCandidates = candidates.filter(
    (candidate) =>
      candidate.exactTitle &&
      candidate.exactAuthor &&
      (candidate.basenameTitle || candidate.basenameAuthor),
  );

  if (exactCandidates.length > 1 && exactCandidates[1].score >= exactCandidates[0].score - 3) {
    return {
      file: null,
      confidence: "ambiguous",
      automaticSendSafe: false,
      message: "Multiple possible files matched. Please review before sending to Kindle.",
    };
  }

  if (
    exactCandidates[0] &&
    exactCandidates[0].score >= top.score - 3 &&
    exactCandidates[0].file.path === top.file.path
  ) {
    return {
      file: top.file,
      confidence: "exact",
      automaticSendSafe: true,
      message: "Book found in watched folder.",
    };
  }

  if (candidates[1] && candidates[1].score >= top.score - 2) {
    return {
      file: null,
      confidence: "ambiguous",
      automaticSendSafe: false,
      message: "Multiple possible files matched. Please review before sending to Kindle.",
    };
  }

  return {
    file: top.file,
    confidence: "candidate",
    automaticSendSafe: false,
    message: "Possible book match found. Please review before sending to Kindle.",
  };
}

export function findBestMatchingFile(
  request: BookRequestRecord,
  files: WatchedBookFile[],
) {
  return findFileMatch(request, files).file;
}

export function getAutomaticDeliveryMatch(
  request: BookRequestRecord,
  files: WatchedBookFile[],
) {
  const match = findFileMatch(request, files);

  if (!match.automaticSendSafe || !match.file) {
    return null;
  }

  return match.file;
}

export async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
