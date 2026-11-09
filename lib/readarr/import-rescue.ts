import { isReadarrConfigured } from "@/lib/config";
import { readarrFetch } from "@/lib/readarr/service";
import type { ReadarrEdition, ReadarrLookupBook } from "@/lib/readarr/types";
import type { BookRequestFormat } from "@/lib/requests/types";

// Readarr sometimes finishes a download but never imports it: the queue loses
// the link to the book it grabbed, and identifying the files from their tags
// fails (for example when the metadata server is slow). The files then sit in
// the downloads folder and never reach the library (or Audiobookshelf).
//
// This job imports such downloads into the book Readarr originally grabbed them
// for. It only acts when that is unambiguous: the grab history names exactly
// one book, that book has no files yet, and the download has been stuck for a
// while. Everything else is logged so a person can sort it out.

export const STUCK_IMPORT_GRACE_MS = 30 * 60_000;
const RETRY_AFTER_MS = 6 * 60 * 60_000;
const MAX_ATTEMPTS = 2;
const MAX_IMPORTS_PER_CYCLE = 3;
// Readarr reads tags from every file when it lists a download for import.
const MANUAL_IMPORT_SCAN_TIMEOUT_MS = 5 * 60_000;
const STUCK_STATES = new Set(["importpending", "importblocked", "importfailed"]);
const FORMAT_EXTENSIONS: Record<BookRequestFormat, Set<string>> = {
  audiobook: new Set(["mp3", "m4b", "m4a", "aac", "flac", "ogg", "opus", "wma", "wav"]),
  ebook: new Set(["epub", "mobi", "azw", "azw3", "pdf"]),
};

export type ReadarrQueueRecord = {
  id: number;
  bookId?: number | null;
  authorId?: number | null;
  title?: string | null;
  status?: string | null;
  trackedDownloadState?: string | null;
  downloadId?: string | null;
  outputPath?: string | null;
};

export type ReadarrHistoryRecord = {
  bookId?: number | null;
  authorId?: number | null;
  downloadId?: string | null;
  eventType?: string | number | null;
};

export type ReadarrManualImportItem = {
  path?: string | null;
  foreignEditionId?: string | null;
  quality?: unknown;
  indexerFlags?: number | null;
  additionalFile?: boolean | null;
};

export type ReadarrManualImportFile = {
  path: string;
  authorId: number;
  bookId: number;
  foreignEditionId: string | null;
  quality: unknown;
  indexerFlags: number;
  downloadId: string;
  disableReleaseSwitching: boolean;
};

export type ImportRescueClient = {
  isConfigured(): boolean;
  getQueue(): Promise<ReadarrQueueRecord[]>;
  getGrabHistory(downloadId: string): Promise<ReadarrHistoryRecord[]>;
  getBook(bookId: number): Promise<ReadarrLookupBook>;
  getEditions(bookId: number): Promise<ReadarrEdition[]>;
  getManualImportItems(input: { downloadId: string; authorId: number }): Promise<ReadarrManualImportItem[]>;
  runManualImport(files: ReadarrManualImportFile[]): Promise<void>;
};

type TrackedDownload = {
  firstSeenAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  flagged: string | null;
};

export type ImportRescueState = Map<string, TrackedDownload>;

export type ImportRescueOutcome =
  | { kind: "imported"; format: BookRequestFormat; title: string; bookId: number; files: number }
  | { kind: "needs-attention"; format: BookRequestFormat; title: string; reason: string };

declare global {
  var __kindlingImportRescueState: ImportRescueState | undefined;
}

function getDefaultState() {
  globalThis.__kindlingImportRescueState ??= new Map();
  return globalThis.__kindlingImportRescueState;
}

type Paged<T> = { records?: T[] | null };

export function createReadarrImportRescueClient(format: BookRequestFormat): ImportRescueClient {
  return {
    isConfigured: () => isReadarrConfigured(format),
    async getQueue() {
      const page = await readarrFetch<Paged<ReadarrQueueRecord>>(format, "/api/v1/queue", undefined, {
        page: 1,
        pageSize: 200,
        includeUnknownAuthorItems: true,
        includeAuthor: false,
        includeBook: false,
      });
      return page.records ?? [];
    },
    async getGrabHistory(downloadId) {
      const page = await readarrFetch<Paged<ReadarrHistoryRecord>>(format, "/api/v1/history", undefined, {
        page: 1,
        pageSize: 50,
        downloadId,
        eventType: 1,
      });
      return page.records ?? [];
    },
    getBook: (bookId) => readarrFetch<ReadarrLookupBook>(format, `/api/v1/book/${bookId}`),
    getEditions: (bookId) => readarrFetch<ReadarrEdition[]>(format, "/api/v1/edition", undefined, { bookId }),
    // With a downloadId Readarr finds the folder itself, applying its remote path
    // mappings; the queue's outputPath is the download client's own path.
    getManualImportItems: ({ downloadId, authorId }) =>
      readarrFetch<ReadarrManualImportItem[]>(
        format,
        "/api/v1/manualimport",
        undefined,
        { downloadId, authorId, filterExistingFiles: true, replaceExistingFiles: false },
        MANUAL_IMPORT_SCAN_TIMEOUT_MS,
      ),
    async runManualImport(files) {
      await readarrFetch(format, "/api/v1/command", {
        method: "POST",
        // Copy rather than move: "auto" moves Usenet downloads, so an import that
        // only partly succeeds could leave the remaining files nowhere. With
        // "Remove Completed" on, Readarr still cleans up the download afterwards.
        body: JSON.stringify({ name: "ManualImport", importMode: "copy", files }),
      });
    },
  };
}

function isStuckImport(item: ReadarrQueueRecord) {
  return Boolean(
    item.downloadId &&
    item.outputPath &&
    (item.status ?? "").toLowerCase() === "completed" &&
    STUCK_STATES.has((item.trackedDownloadState ?? "").toLowerCase()),
  );
}

function isGrabEvent(record: ReadarrHistoryRecord) {
  return record.eventType === 1 || String(record.eventType ?? "").toLowerCase() === "grabbed";
}

function hasFormatExtension(path: string, format: BookRequestFormat) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return FORMAT_EXTENSIONS[format].has(extension);
}

function pickForeignEditionId(book: ReadarrLookupBook, editions: ReadarrEdition[]) {
  const all = [...editions, ...(book.editions ?? [])].filter((edition) => edition.foreignEditionId);
  return all.find((edition) => edition.monitored)?.foreignEditionId ?? book.foreignEditionId ?? all[0]?.foreignEditionId ?? null;
}

async function resolveGrabbedBookId(client: ImportRescueClient, item: ReadarrQueueRecord) {
  const history = await client.getGrabHistory(item.downloadId!);
  const bookIds = new Set(
    history
      .filter((record) => isGrabEvent(record) && record.downloadId === item.downloadId)
      .map((record) => record.bookId)
      .filter((id): id is number => typeof id === "number" && id > 0),
  );
  if (typeof item.bookId === "number" && item.bookId > 0) bookIds.add(item.bookId);
  if (bookIds.size === 0) return { bookId: null, reason: "Readarr has no record of which book this download was for." };
  if (bookIds.size > 1) return { bookId: null, reason: "This download was grabbed for several books, so it needs sorting by hand." };
  return { bookId: [...bookIds][0], reason: null };
}

export async function runImportRescueCycle(options: {
  clients?: Partial<Record<BookRequestFormat, ImportRescueClient>>;
  state?: ImportRescueState;
  now?: () => number;
  graceMs?: number;
  log?: (message: string) => void;
} = {}) {
  const clients = options.clients ?? {
    ebook: createReadarrImportRescueClient("ebook"),
    audiobook: createReadarrImportRescueClient("audiobook"),
  };
  const state = options.state ?? getDefaultState();
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? STUCK_IMPORT_GRACE_MS;
  const log = options.log ?? ((message: string) => console.warn(`[kindling worker] ${message}`));
  const outcomes: ImportRescueOutcome[] = [];
  const seen = new Set<string>();
  const scannedFormats = new Set<BookRequestFormat>();
  const failures: string[] = [];
  let importsThisCycle = 0;

  for (const [format, client] of Object.entries(clients) as Array<[BookRequestFormat, ImportRescueClient | undefined]>) {
    if (!client?.isConfigured()) continue;
    let queue: ReadarrQueueRecord[];
    try {
      queue = await client.getQueue();
    } catch (error) {
      // One Readarr being down must not stop the other instance's rescue.
      failures.push(`${format}: ${error instanceof Error ? error.message : "could not read the Readarr queue"}`);
      continue;
    }
    scannedFormats.add(format);

    for (const item of queue) {
      if (!isStuckImport(item)) continue;
      const key = `${format}:${item.downloadId}`;
      seen.add(key);
      const tracked = state.get(key) ?? { firstSeenAt: now(), attempts: 0, lastAttemptAt: null, flagged: null };
      state.set(key, tracked);

      if (now() - tracked.firstSeenAt < graceMs) continue;
      if (tracked.attempts >= MAX_ATTEMPTS) continue;
      if (tracked.lastAttemptAt !== null && now() - tracked.lastAttemptAt < RETRY_AFTER_MS) continue;
      if (importsThisCycle >= MAX_IMPORTS_PER_CYCLE) continue;

      const title = item.title?.trim() || item.downloadId!;
      const flag = (reason: string) => {
        if (tracked.flagged !== reason) {
          tracked.flagged = reason;
          log(`${format} download "${title}" is stuck in Readarr and needs attention: ${reason}`);
        }
        outcomes.push({ kind: "needs-attention", format, title, reason });
      };

      try {
        const resolved = await resolveGrabbedBookId(client, item);
        if (resolved.bookId === null) {
          flag(resolved.reason!);
          continue;
        }

        const book = await client.getBook(resolved.bookId);
        const authorId = book.authorId ?? book.author?.id;
        if (!authorId) {
          flag("Readarr did not say which author the grabbed book belongs to.");
          continue;
        }
        if ((book.statistics?.bookFileCount ?? 0) > 0) {
          flag(`"${book.title}" already has files in the library, so this looks like a second copy.`);
          continue;
        }

        tracked.attempts += 1;
        tracked.lastAttemptAt = now();
        importsThisCycle += 1;

        const [candidates, editions] = await Promise.all([
          client.getManualImportItems({ downloadId: item.downloadId!, authorId }),
          client.getEditions(resolved.bookId),
        ]);
        const foreignEditionId = pickForeignEditionId(book, editions);
        const files = candidates
          .filter((candidate) => candidate.path && !candidate.additionalFile && hasFormatExtension(candidate.path, format))
          .map((candidate): ReadarrManualImportFile => ({
            path: candidate.path!,
            authorId,
            bookId: resolved.bookId!,
            foreignEditionId: foreignEditionId ?? candidate.foreignEditionId ?? null,
            quality: candidate.quality,
            indexerFlags: candidate.indexerFlags ?? 0,
            downloadId: item.downloadId!,
            disableReleaseSwitching: false,
          }));

        if (files.length === 0) {
          flag(`Readarr found no ${format} files to import in ${item.outputPath}.`);
          continue;
        }

        await client.runManualImport(files);
        tracked.flagged = null;
        log(`Asked Readarr to import ${files.length} file(s) from "${title}" into "${book.title}" (${format}).`);
        outcomes.push({ kind: "imported", format, title, bookId: resolved.bookId, files: files.length });
      } catch (error) {
        failures.push(`${format} "${title}": ${error instanceof Error ? error.message : "import check failed"}`);
      }
    }
  }

  for (const key of state.keys()) {
    const format = key.slice(0, key.indexOf(":")) as BookRequestFormat;
    if (scannedFormats.has(format) && !seen.has(key)) state.delete(key);
  }

  if (failures.length > 0) {
    throw new Error(`Stuck import check failed for ${failures.join("; ")}`);
  }

  return outcomes;
}
