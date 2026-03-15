import type { ReadarrLookupBook } from "@/lib/readarr/types";
import type { DeliveryWorkerStatus } from "@/lib/delivery/types";

export type BookRequestFormat = "ebook" | "audiobook";

export type BookRequestStatus =
  | "requested"
  | "searching"
  | "downloading"
  | "available"
  | "not-monitored"
  | "failed";

export type BookRequestFilter = "all" | "active" | "available";

export type SearchResultAvailability =
  | "requestable"
  | "unavailable"
  | "requested-by-you"
  | "already-requested"
  | "already-available";

export type LocalUser = {
  id: number;
  name: string;
  kindleEmail: string | null;
  createdAt: string;
  requestCount: number;
};

export type BookRequestRecord = {
  id: number;
  userId: number;
  userName: string;
  requestFormat: BookRequestFormat;
  requestFingerprint: string;
  requestedTitle: string;
  requestedAuthor: string;
  requestedYear: number | null;
  requestedAt: string;
  status: BookRequestStatus;
  statusMessage: string | null;
  foreignAuthorId: string | null;
  foreignBookId: string | null;
  foreignEditionId: string | null;
  readarrAuthorId: number | null;
  readarrBookId: number | null;
  readarrEditionId: number | null;
  coverUrl: string | null;
  notes: string | null;
  searchAttemptCount: number;
  nextSearchAttemptAt: string | null;
  lastSearchAttemptAt: string | null;
  lastSearchErrorMessage: string | null;
  lastSyncedAt: string | null;
  matchedFilePath: string | null;
  matchedAt: string | null;
  lastDeliveryAt: string | null;
  lastDeliveryRecipient: string | null;
  lastDeliveryTrigger: "automatic" | "manual" | null;
  lastDeliveryMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SearchResultRequestAction = {
  format: BookRequestFormat;
  availability: SearchResultAvailability;
  availabilityLabel: string;
  availabilityDescription: string;
  request: BookRequestRecord | null;
  source: ReadarrLookupBook | null;
};

export type SearchResultItem = {
  fingerprint: string;
  title: string;
  author: string;
  year: number | null;
  coverUrl: string | null;
  actions: Record<BookRequestFormat, SearchResultRequestAction>;
};

export type HealthResponse = {
  app: "ok";
  database: "ok" | "error";
  readarr: {
    configured: boolean;
    reachable: boolean;
    version: string | null;
    message: string;
  };
  audiobookReadarr: {
    configured: boolean;
    reachable: boolean;
    version: string | null;
    message: string;
  };
  worker: DeliveryWorkerStatus;
};
