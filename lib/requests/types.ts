import type { ReadarrLookupBook } from "@/lib/readarr/types";

export type BookRequestStatus =
  | "requested"
  | "searching"
  | "downloading"
  | "available"
  | "failed";

export type BookRequestFilter = "all" | "active" | "available";

export type SearchResultAvailability =
  | "requestable"
  | "requested-by-you"
  | "already-requested"
  | "already-available";

export type LocalUser = {
  id: number;
  name: string;
  createdAt: string;
};

export type BookRequestRecord = {
  id: number;
  userId: number;
  userName: string;
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
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SearchResultItem = {
  fingerprint: string;
  title: string;
  author: string;
  year: number | null;
  coverUrl: string | null;
  availability: SearchResultAvailability;
  availabilityLabel: string;
  availabilityDescription: string;
  request: BookRequestRecord | null;
  source: ReadarrLookupBook;
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
};
