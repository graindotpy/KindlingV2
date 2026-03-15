import { getAppConfig } from "@/lib/config";
import { createBookRequestsRepository } from "@/lib/db/repositories/book-requests";
import { createSettingsRepository } from "@/lib/db/repositories/settings";
import type { DeliveryWorkerStatus } from "@/lib/delivery/types";

const WATCH_DIRECTORY_KEY = "delivery.watchDirectory";
const WORKER_LAST_STARTED_AT_KEY = "worker.lastStartedAt";
const WORKER_LAST_HEARTBEAT_AT_KEY = "worker.lastHeartbeatAt";
const WORKER_LAST_SUCCESS_AT_KEY = "worker.lastSuccessAt";
const WORKER_LAST_ERROR_AT_KEY = "worker.lastErrorAt";
const WORKER_LAST_ERROR_MESSAGE_KEY = "worker.lastErrorMessage";

function getSettingValue(key: string) {
  return createSettingsRepository().get(key)?.value ?? null;
}

function setSettingValue(key: string, value: string | null, updatedAt: string) {
  createSettingsRepository().set(key, value, updatedAt);
}

function getWorkerFreshnessWindowMs() {
  return Math.max(getAppConfig().delivery.scanIntervalMs * 2 + 15_000, 90_000);
}

export function recordWorkerStarted(timestamp: string) {
  setSettingValue(WORKER_LAST_STARTED_AT_KEY, timestamp, timestamp);
  setSettingValue(WORKER_LAST_HEARTBEAT_AT_KEY, timestamp, timestamp);
}

export function recordWorkerHeartbeat(timestamp: string) {
  setSettingValue(WORKER_LAST_HEARTBEAT_AT_KEY, timestamp, timestamp);
}

export function recordWorkerSuccess(timestamp: string) {
  setSettingValue(WORKER_LAST_SUCCESS_AT_KEY, timestamp, timestamp);
  setSettingValue(WORKER_LAST_ERROR_AT_KEY, null, timestamp);
  setSettingValue(WORKER_LAST_ERROR_MESSAGE_KEY, null, timestamp);
}

export function recordWorkerError(timestamp: string, message: string) {
  setSettingValue(WORKER_LAST_ERROR_AT_KEY, timestamp, timestamp);
  setSettingValue(WORKER_LAST_ERROR_MESSAGE_KEY, message, timestamp);
}

export function getBackgroundWorkerStatus(): DeliveryWorkerStatus {
  const watchDirectory = getSettingValue(WATCH_DIRECTORY_KEY);
  const hasPendingSearchRetries = createBookRequestsRepository().hasPendingSearchRetries();
  const lastStartedAt = getSettingValue(WORKER_LAST_STARTED_AT_KEY);
  const lastHeartbeatAt = getSettingValue(WORKER_LAST_HEARTBEAT_AT_KEY);
  const lastSuccessAt = getSettingValue(WORKER_LAST_SUCCESS_AT_KEY);
  const lastErrorAt = getSettingValue(WORKER_LAST_ERROR_AT_KEY);
  const lastErrorMessage = getSettingValue(WORKER_LAST_ERROR_MESSAGE_KEY);
  const expected = Boolean(watchDirectory?.trim()) || hasPendingSearchRetries;
  const lastHeartbeatMs = lastHeartbeatAt ? new Date(lastHeartbeatAt).getTime() : NaN;
  const running =
    Number.isFinite(lastHeartbeatMs) &&
    Date.now() - lastHeartbeatMs <= getWorkerFreshnessWindowMs();

  let message = "Background work is idle until automatic delivery or queued search retries need it.";

  if (expected && running) {
    message = "Background worker is running.";
  } else if (expected && lastErrorAt && lastErrorMessage) {
    message = `Background worker is failing: ${lastErrorMessage}`;
  } else if (expected) {
    message = "Background worker is not reporting in. Start `npm run worker`.";
  }

  return {
    expected,
    running,
    lastStartedAt,
    lastHeartbeatAt,
    lastSuccessAt,
    lastErrorAt,
    lastErrorMessage,
    message,
  };
}
