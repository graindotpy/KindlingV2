import { createBookRequestsRepository } from "@/lib/db/repositories/book-requests";
import { createDeliveryAttemptsRepository } from "@/lib/db/repositories/delivery-attempts";
import { createUsersRepository } from "@/lib/db/repositories/users";
import {
  fileExists,
  findBestMatchingFile,
  findFileMatch,
  getAutomaticDeliveryMatch,
  scanWatchDirectory,
  type WatchedBookFile,
} from "@/lib/delivery/files";
import { createSmtpMailer, type KindleMailer } from "@/lib/delivery/mailer";
import type { SendToKindleInput, SendToKindleResult } from "@/lib/delivery/types";
import type { BookRequestRecord, LocalUser } from "@/lib/requests/types";
import { supportsKindleDelivery } from "@/lib/requests/status";
import { getDeliveryRuntimeSettings } from "@/lib/settings/service";

type RequestsRepository = ReturnType<typeof createBookRequestsRepository>;
type DeliveryAttemptsRepository = ReturnType<typeof createDeliveryAttemptsRepository>;
type UsersRepository = ReturnType<typeof createUsersRepository>;

type DeliveryServiceDependencies = {
  requestsRepo: RequestsRepository;
  attemptsRepo: DeliveryAttemptsRepository;
  usersRepo: UsersRepository;
  mailer: KindleMailer;
  now: () => string;
  scanFiles: (rootDir: string) => Promise<WatchedBookFile[]>;
  fileExists: (filePath: string) => Promise<boolean>;
  getSettings: typeof getDeliveryRuntimeSettings;
};

export class KindleDeliveryError extends Error {
  attempt: SendToKindleResult["attempt"] | null;
  request: BookRequestRecord | null;

  constructor(
    message: string,
    request: BookRequestRecord | null,
    attempt: SendToKindleResult["attempt"] | null,
  ) {
    super(message);
    this.name = "KindleDeliveryError";
    this.request = request;
    this.attempt = attempt;
  }
}

async function resolveMatchedFile(
  request: BookRequestRecord,
  deps: DeliveryServiceDependencies,
) {
  if (
    !supportsKindleDelivery(request.requestFormat) ||
    request.status === "not-monitored"
  ) {
    return null;
  }

  if (request.matchedFilePath && (await deps.fileExists(request.matchedFilePath))) {
    return request.matchedFilePath;
  }

  const settings = deps.getSettings();
  if (!settings.watchDirectory) {
    return null;
  }

  const files = await deps.scanFiles(settings.watchDirectory);
  const match = findBestMatchingFile(request, files);
  return match?.path ?? null;
}

function ensureRecipientCanReceiveBooks(recipient: LocalUser) {
  const kindleEmail = recipient.kindleEmail?.trim().toLowerCase() ?? "";
  if (!kindleEmail) {
    throw new Error(`${recipient.name} does not have a Kindle email yet.`);
  }

  return kindleEmail;
}

function toSnapshotRecipient(recipient: LocalUser) {
  return recipient.kindleEmail?.trim().toLowerCase() ?? recipient.name;
}

export function createDeliveryService(
  partialDeps: Partial<DeliveryServiceDependencies> = {},
) {
  const deps: DeliveryServiceDependencies = {
    requestsRepo: partialDeps.requestsRepo ?? createBookRequestsRepository(),
    attemptsRepo: partialDeps.attemptsRepo ?? createDeliveryAttemptsRepository(),
    usersRepo: partialDeps.usersRepo ?? createUsersRepository(),
    mailer: partialDeps.mailer ?? createSmtpMailer(),
    now: partialDeps.now ?? (() => new Date().toISOString()),
    scanFiles: partialDeps.scanFiles ?? scanWatchDirectory,
    fileExists: partialDeps.fileExists ?? fileExists,
    getSettings: partialDeps.getSettings ?? getDeliveryRuntimeSettings,
  };

  async function markRequestAsMatched(
    request: BookRequestRecord,
    filePath: string,
    timestamp: string,
    message: string,
  ) {
    const patch = {
      matchedFilePath: filePath,
      matchedAt: request.matchedAt ?? timestamp,
      status: "available" as const,
      statusMessage: message,
      updatedAt: timestamp,
    };

    return deps.requestsRepo.update(request.id, patch) ?? request;
  }

  return {
    getSettings() {
      return deps.getSettings();
    },

    async findMatchedFile(requestId: number) {
      const request = deps.requestsRepo.findById(requestId);
      if (!request) {
        throw new Error("We could not find that request.");
      }

      return resolveMatchedFile(request, deps);
    },

    async sendMatchedBookToUser(input: SendToKindleInput): Promise<SendToKindleResult> {
      const request = deps.requestsRepo.findById(input.requestId);
      if (!request) {
        throw new Error("We could not find that request.");
      }

      if (!supportsKindleDelivery(request.requestFormat)) {
        throw new Error("Audiobook requests cannot be sent to Kindle from Kindling.");
      }

      const recipientEmail = ensureRecipientCanReceiveBooks(input.recipient);
      const matchedFilePath = await resolveMatchedFile(request, deps);

      if (!matchedFilePath) {
        throw new Error("Kindling has not found this book in the watched folder yet.");
      }

      const timestamp = deps.now();
      const syncedRequest = await markRequestAsMatched(
        request,
        matchedFilePath,
        timestamp,
        "Book found in watched folder.",
      );

      try {
        const message = await deps.mailer.sendBook({
          to: recipientEmail,
          title: syncedRequest.requestedTitle,
          author: syncedRequest.requestedAuthor,
          requestedBy: syncedRequest.userName,
          filePath: matchedFilePath,
        });

        const attempt = deps.attemptsRepo.create({
          bookRequestId: syncedRequest.id,
          recipientUserId: input.recipient.id,
          recipientName: input.recipient.name,
          recipientEmail,
          filePath: matchedFilePath,
          trigger: input.trigger,
          status: "sent",
          message,
          createdAt: timestamp,
          sentAt: timestamp,
        });

        const updatedRequest = deps.requestsRepo.update(syncedRequest.id, {
          lastDeliveryAt: timestamp,
          lastDeliveryRecipient: recipientEmail,
          lastDeliveryTrigger: input.trigger,
          lastDeliveryMessage: message,
          updatedAt: timestamp,
        });

        if (!attempt || !updatedRequest) {
          throw new Error("Kindling could not record that delivery.");
        }

        return {
          request: updatedRequest,
          attempt,
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Kindling could not send that file to Kindle.";

        const attempt =
          deps.attemptsRepo.create({
            bookRequestId: syncedRequest.id,
            recipientUserId: input.recipient.id,
            recipientName: input.recipient.name,
            recipientEmail,
            filePath: matchedFilePath,
            trigger: input.trigger,
            status: "failed",
            message,
            createdAt: timestamp,
            sentAt: null,
          }) ?? null;

        const updatedRequest =
          deps.requestsRepo.update(syncedRequest.id, {
            lastDeliveryRecipient: toSnapshotRecipient(input.recipient),
            lastDeliveryTrigger: input.trigger,
            lastDeliveryMessage: message,
            updatedAt: timestamp,
          }) ?? syncedRequest;

        throw new KindleDeliveryError(message, updatedRequest, attempt);
      }
    },

    async runAutomaticWatchCycle() {
      const settings = deps.getSettings();
      if (!settings.watchDirectory) {
        return;
      }

      const files = await deps.scanFiles(settings.watchDirectory);
      if (files.length === 0) {
        return;
      }

      const requests = deps.requestsRepo.listAll();

      for (const request of requests) {
        if (
          !supportsKindleDelivery(request.requestFormat) ||
          request.status === "not-monitored"
        ) {
          continue;
        }

        const match = findFileMatch(request, files);
        const matchedFile = match.file;
        if (!matchedFile) {
          continue;
        }

        const timestamp = deps.now();
        const current =
          request.matchedFilePath !== matchedFile.path ||
          request.status !== "available" ||
          request.statusMessage !== match.message
            ? await markRequestAsMatched(
                request,
                matchedFile.path,
                timestamp,
                match.message ?? "Book found in watched folder.",
              )
            : request;

        const automaticMatch = getAutomaticDeliveryMatch(request, files);
        if (!automaticMatch || automaticMatch.path !== matchedFile.path) {
          continue;
        }

        const requester = deps.usersRepo.getById(current.userId);
        if (!requester?.kindleEmail || !deps.mailer.isConfigured()) {
          continue;
        }

        const previousAttempt = deps.attemptsRepo.findMatchingAutomaticAttempt(
          current.id,
          "automatic",
          requester.kindleEmail,
          automaticMatch.path,
        );

        if (previousAttempt) {
          continue;
        }

        try {
          await this.sendMatchedBookToUser({
            requestId: current.id,
            recipient: requester,
            trigger: "automatic",
          });
        } catch {
          continue;
        }
      }
    },
  };
}
