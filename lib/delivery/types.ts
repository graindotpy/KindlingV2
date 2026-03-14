import type { BookRequestRecord, LocalUser } from "@/lib/requests/types";

export type DeliveryTrigger = "automatic" | "manual";
export type DeliveryAttemptStatus = "sent" | "failed";
export type DeliveryWatchDirectoryState =
  | "not-configured"
  | "ready"
  | "missing"
  | "invalid";
export type DeliverySmtpState = "not-configured" | "ready" | "error";

export type DeliveryAttemptRecord = {
  id: number;
  bookRequestId: number;
  recipientUserId: number | null;
  recipientName: string;
  recipientEmail: string;
  filePath: string;
  trigger: DeliveryTrigger;
  status: DeliveryAttemptStatus;
  message: string | null;
  createdAt: string;
  sentAt: string | null;
};

export type DeliveryWorkerStatus = {
  expected: boolean;
  running: boolean;
  lastStartedAt: string | null;
  lastHeartbeatAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  message: string;
};

export type DeliverySettings = {
  watchDirectory: string | null;
  watchDirectoryState: DeliveryWatchDirectoryState;
  watchDirectoryMessage: string;
  smtpConfigured: boolean;
  smtpState: DeliverySmtpState;
  smtpMessage: string;
  automaticDeliveryEnabled: boolean;
  worker: DeliveryWorkerStatus;
};

export type SendToKindleResult = {
  request: BookRequestRecord;
  attempt: DeliveryAttemptRecord;
};

export type SendToKindleInput = {
  requestId: number;
  recipient: LocalUser;
  trigger: DeliveryTrigger;
};
