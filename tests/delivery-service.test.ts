import { describe, expect, it, vi } from "vitest";
import { createDeliveryService } from "@/lib/delivery/service";
import type { KindleMailer } from "@/lib/delivery/mailer";
import type { WatchedBookFile } from "@/lib/delivery/files";
import type { DeliveryAttemptRecord } from "@/lib/delivery/types";
import type { BookRequestRecord, LocalUser } from "@/lib/requests/types";

const FIXED_TIME = "2026-03-13T12:00:00.000Z";
const MATCHED_FILE_PATH = "C:\\Library\\Mary Norton\\The Borrowers.epub";
const CANDIDATE_FILE_PATH = "C:\\Library\\Mary Norton\\Borrowers Collection.epub";

function makeRequest(overrides: Partial<BookRequestRecord> = {}): BookRequestRecord {
  return {
    id: 1,
    userId: 1,
    userName: "Mum",
    requestFormat: "ebook",
    requestFingerprint: "mary-norton::the-borrowers",
    requestedTitle: "The Borrowers",
    requestedAuthor: "Mary Norton",
    requestedYear: 1952,
    requestedAt: FIXED_TIME,
    status: "searching",
    statusMessage: "Readarr is still searching for a copy.",
    foreignAuthorId: null,
    foreignBookId: null,
    foreignEditionId: null,
    readarrAuthorId: null,
    readarrBookId: null,
    readarrEditionId: null,
    coverUrl: null,
    notes: null,
    lastSyncedAt: null,
    matchedFilePath: null,
    matchedAt: null,
    lastDeliveryAt: null,
    lastDeliveryRecipient: null,
    lastDeliveryTrigger: null,
    lastDeliveryMessage: null,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    ...overrides,
  };
}

function makeUser(overrides: Partial<LocalUser> = {}): LocalUser {
  return {
    id: 1,
    name: "Mum",
    kindleEmail: "mum@kindle.com",
    createdAt: FIXED_TIME,
    requestCount: 0,
    ...overrides,
  };
}

function makeWatchedFile(path = MATCHED_FILE_PATH): WatchedBookFile {
  const basename = path.split("\\").at(-1) ?? "The Borrowers.epub";
  return {
    path,
    basename,
    normalizedBasename: basename.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    normalizedPath: path.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
  };
}

function makeHarness() {
  const requests = [makeRequest()];
  const attempts: DeliveryAttemptRecord[] = [];
  let nextAttemptId = 1;

  const requestsRepo = {
    listAll: vi.fn(() => [...requests]),
    findById: vi.fn((id: number) => requests.find((request) => request.id === id) ?? null),
    update: vi.fn((id: number, patch: Partial<BookRequestRecord>) => {
      const index = requests.findIndex((request) => request.id === id);
      if (index === -1) {
        return null;
      }

      requests[index] = {
        ...requests[index],
        ...patch,
        updatedAt: patch.updatedAt ?? FIXED_TIME,
      };

      return requests[index];
    }),
  };

  const attemptsRepo = {
    create: vi.fn((input) => {
      const attempt: DeliveryAttemptRecord = {
        id: nextAttemptId++,
        bookRequestId: input.bookRequestId,
        recipientUserId: input.recipientUserId,
        recipientName: input.recipientName,
        recipientEmail: input.recipientEmail,
        filePath: input.filePath,
        trigger: input.trigger,
        status: input.status,
        message: input.message,
        createdAt: input.createdAt,
        sentAt: input.sentAt,
      };

      attempts.push(attempt);
      return attempt;
    }),
    findMatchingAutomaticAttempt: vi.fn(
      (bookRequestId: number, trigger: "automatic" | "manual", recipientEmail: string, filePath: string) =>
        attempts.find(
          (attempt) =>
            attempt.bookRequestId === bookRequestId &&
            attempt.trigger === trigger &&
            attempt.status === "sent" &&
            attempt.recipientEmail === recipientEmail &&
            attempt.filePath === filePath,
        ) ?? null,
    ),
  };

  const usersRepo = {
    getById: vi.fn((id: number) => (id === 1 ? makeUser() : null)),
  };

  const mailer: KindleMailer = {
    isConfigured: vi.fn(() => true),
    checkConnection: vi.fn(async () => ({
      configured: true,
      reachable: true,
      message: "SMTP ready.",
    })),
    sendBook: vi.fn(async ({ to }) => `Sent The Borrowers.epub to ${to}.`),
  };

  const scanFiles = vi.fn(async () => [makeWatchedFile()]);
  const exists = vi.fn(async () => true);

  const service = createDeliveryService({
    requestsRepo: requestsRepo as never,
    attemptsRepo: attemptsRepo as never,
    usersRepo: usersRepo as never,
    mailer,
    now: () => FIXED_TIME,
    scanFiles,
    fileExists: exists,
    getSettings: () => ({
      watchDirectory: "C:\\Library",
      smtpConfigured: true,
    }),
  });

  return {
    attempts,
    attemptsRepo,
    mailer,
    requests,
    requestsRepo,
    scanFiles,
    service,
    usersRepo,
  };
}

describe("createDeliveryService.sendMatchedBookToUser", () => {
  it("sends a matched file to the selected Kindle profile", async () => {
    const harness = makeHarness();
    harness.requests[0] = makeRequest({
      matchedFilePath: MATCHED_FILE_PATH,
      matchedAt: FIXED_TIME,
      status: "available",
      statusMessage: "Book found in watched folder.",
    });

    const recipient = makeUser({
      id: 2,
      name: "Dad",
      kindleEmail: "dad@kindle.com",
    });

    const result = await harness.service.sendMatchedBookToUser({
      requestId: 1,
      recipient,
      trigger: "manual",
    });

    expect(harness.mailer.sendBook).toHaveBeenCalledTimes(1);
    expect(result.request.lastDeliveryRecipient).toBe("dad@kindle.com");
    expect(result.request.lastDeliveryTrigger).toBe("manual");
    expect(result.attempt.status).toBe("sent");
  });

  it("rejects audiobook requests for Kindle delivery", async () => {
    const harness = makeHarness();
    harness.requests[0] = makeRequest({
      requestFormat: "audiobook",
    });

    await expect(
      harness.service.sendMatchedBookToUser({
        requestId: 1,
        recipient: makeUser(),
        trigger: "manual",
      }),
    ).rejects.toThrow("Audiobook requests cannot be sent to Kindle from Kindling.");
  });
});

describe("createDeliveryService.runAutomaticWatchCycle", () => {
  it("matches a watched file and only auto-sends it once", async () => {
    const harness = makeHarness();

    await harness.service.runAutomaticWatchCycle();
    await harness.service.runAutomaticWatchCycle();

    expect(harness.requests[0]?.matchedFilePath).toBe(MATCHED_FILE_PATH);
    expect(harness.requests[0]?.status).toBe("available");
    expect(harness.mailer.sendBook).toHaveBeenCalledTimes(1);
    expect(harness.attemptsRepo.findMatchingAutomaticAttempt).toHaveBeenCalled();
  });

  it("retries automatic delivery after a failed send attempt", async () => {
    const harness = makeHarness();
    vi.mocked(harness.mailer.sendBook)
      .mockRejectedValueOnce(new Error("SMTP offline."))
      .mockResolvedValueOnce("Sent The Borrowers.epub to mum@kindle.com.");

    await harness.service.runAutomaticWatchCycle();
    await harness.service.runAutomaticWatchCycle();

    expect(harness.mailer.sendBook).toHaveBeenCalledTimes(2);
    expect(harness.attempts.filter((attempt) => attempt.status === "failed")).toHaveLength(1);
    expect(harness.attempts.filter((attempt) => attempt.status === "sent")).toHaveLength(1);
  });

  it("marks a fuzzy candidate match for manual review without auto-sending it", async () => {
    const harness = makeHarness();
    harness.scanFiles.mockResolvedValueOnce([makeWatchedFile(CANDIDATE_FILE_PATH)]);

    await harness.service.runAutomaticWatchCycle();

    expect(harness.requests[0]?.matchedFilePath).toBe(CANDIDATE_FILE_PATH);
    expect(harness.requests[0]?.status).toBe("available");
    expect(harness.requests[0]?.statusMessage).toContain("Please review");
    expect(harness.mailer.sendBook).not.toHaveBeenCalled();
  });

  it("ignores requests that are not monitored anymore", async () => {
    const harness = makeHarness();
    harness.requests[0] = makeRequest({
      status: "not-monitored",
      statusMessage: "This request is not monitored in Readarr right now.",
    });

    await harness.service.runAutomaticWatchCycle();

    expect(harness.requests[0]?.matchedFilePath).toBeNull();
    expect(harness.requests[0]?.status).toBe("not-monitored");
    expect(harness.mailer.sendBook).not.toHaveBeenCalled();
  });
});
