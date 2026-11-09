import { describe, expect, it, vi } from "vitest";
import {
  runImportRescueCycle,
  type ImportRescueClient,
  type ImportRescueState,
  type ReadarrQueueRecord,
} from "@/lib/readarr/import-rescue";
import type { ReadarrLookupBook } from "@/lib/readarr/types";

const MINUTE = 60_000;

function stuckItem(overrides: Partial<ReadarrQueueRecord> = {}): ReadarrQueueRecord {
  return {
    id: 1,
    bookId: null,
    title: "Steven Erikson - Memories of Ice",
    status: "completed",
    trackedDownloadState: "importPending",
    downloadId: "SABnzbd_nzo_1",
    outputPath: "/data/downloads/audiobooks/Memories of Ice",
    ...overrides,
  };
}

function erikson(overrides: Partial<ReadarrLookupBook> = {}): ReadarrLookupBook {
  return {
    id: 30,
    authorId: 7,
    title: "Memories of Ice",
    foreignBookId: "55399",
    author: { id: 7, authorName: "Steven Erikson", foreignAuthorId: "31232" },
    editions: [{ foreignEditionId: "e-1", monitored: true }],
    statistics: { bookFileCount: 0 },
    ...overrides,
  };
}

function fakeClient(overrides: Partial<ImportRescueClient> = {}) {
  const client = {
    isConfigured: () => true,
    getQueue: vi.fn(async () => [stuckItem()]),
    getGrabHistory: vi.fn(async () => [{ eventType: "grabbed", bookId: 30, authorId: 7, downloadId: "SABnzbd_nzo_1" }]),
    getBook: vi.fn(async () => erikson()),
    getEditions: vi.fn(async () => [{ foreignEditionId: "175983", monitored: true }]),
    getManualImportItems: vi.fn(async () => [
      { path: "/DATA/audiobooks/Memories of Ice/01.mp3", quality: { quality: { id: 10 } } },
      { path: "/DATA/audiobooks/Memories of Ice/02.mp3", quality: { quality: { id: 10 } } },
      { path: "/DATA/audiobooks/Memories of Ice/cover.jpg", quality: null },
    ]),
    runManualImport: vi.fn(async () => {}),
    ...overrides,
  };
  return client;
}

async function runAt(client: ImportRescueClient, state: ImportRescueState, at: number) {
  return runImportRescueCycle({ clients: { audiobook: client }, state, now: () => at, log: () => {} });
}

describe("stuck import rescue", () => {
  it("waits out the grace period, then imports into the grabbed book", async () => {
    const client = fakeClient();
    const state: ImportRescueState = new Map();

    expect(await runAt(client, state, 0)).toEqual([]);
    expect(client.getGrabHistory).not.toHaveBeenCalled();

    const outcomes = await runAt(client, state, 31 * MINUTE);
    expect(outcomes).toEqual([
      { kind: "imported", format: "audiobook", title: "Steven Erikson - Memories of Ice", bookId: 30, files: 2 },
    ]);
    expect(client.getManualImportItems).toHaveBeenCalledWith({
      downloadId: "SABnzbd_nzo_1",
      authorId: 7,
    });
    expect(client.runManualImport).toHaveBeenCalledWith([
      expect.objectContaining({ path: "/DATA/audiobooks/Memories of Ice/01.mp3", bookId: 30, authorId: 7, foreignEditionId: "175983", downloadId: "SABnzbd_nzo_1" }),
      expect.objectContaining({ path: "/DATA/audiobooks/Memories of Ice/02.mp3" }),
    ]);

    // It does not hammer Readarr while the import is in progress.
    await runAt(client, state, 40 * MINUTE);
    expect(client.runManualImport).toHaveBeenCalledOnce();
  });

  it("leaves downloads alone when the grabbed book is ambiguous or unknown", async () => {
    const ambiguous = fakeClient({
      getGrabHistory: vi.fn(async () => [
        { eventType: "grabbed", bookId: 30, downloadId: "SABnzbd_nzo_1" },
        { eventType: "grabbed", bookId: 31, downloadId: "SABnzbd_nzo_1" },
      ]),
    });
    const unknown = fakeClient({ getGrabHistory: vi.fn(async () => []) });

    for (const client of [ambiguous, unknown]) {
      const state: ImportRescueState = new Map();
      await runAt(client, state, 0);
      const outcomes = await runAt(client, state, 31 * MINUTE);
      expect(outcomes[0]?.kind).toBe("needs-attention");
      expect(client.runManualImport).not.toHaveBeenCalled();
    }
  });

  it("never imports a second copy into a book that already has files", async () => {
    const client = fakeClient({ getBook: vi.fn(async () => erikson({ statistics: { bookFileCount: 26 } })) });
    const state: ImportRescueState = new Map();
    await runAt(client, state, 0);
    const outcomes = await runAt(client, state, 31 * MINUTE);
    expect(outcomes[0]).toMatchObject({ kind: "needs-attention" });
    expect(client.getManualImportItems).not.toHaveBeenCalled();
  });

  it("ignores downloads that are still downloading or importing normally", async () => {
    const client = fakeClient({
      getQueue: vi.fn(async () => [
        stuckItem({ status: "downloading", trackedDownloadState: "downloading" }),
        stuckItem({ downloadId: "b", trackedDownloadState: "importing" }),
      ]),
    });
    const state: ImportRescueState = new Map();
    await runAt(client, state, 0);
    expect(await runAt(client, state, 60 * MINUTE)).toEqual([]);
    expect(state.size).toBe(0);
  });
});
