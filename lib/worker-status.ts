import { createSettingsRepository } from "@/lib/db/repositories/settings";
import type { DeliveryWorkerStatus } from "@/lib/delivery/types";

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

// Heartbeats run every 15 seconds independently of the scan interval.
const WORKER_FRESHNESS_WINDOW_MS = 90_000;

export function recordWorkerStarted(timestamp: string) {
  setSettingValue(WORKER_LAST_STARTED_AT_KEY, timestamp, timestamp);
  setSettingValue(WORKER_LAST_HEARTBEAT_AT_KEY, timestamp, timestamp);
}

export function recordWorkerHeartbeat(timestamp: string) {
  setSettingValue(WORKER_LAST_HEARTBEAT_AT_KEY, timestamp, timestamp);
}

export function recordWorkerStopped(timestamp: string) {
  setSettingValue(WORKER_LAST_HEARTBEAT_AT_KEY, null, timestamp);
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
  const lastStartedAt = getSettingValue(WORKER_LAST_STARTED_AT_KEY);
  const lastHeartbeatAt = getSettingValue(WORKER_LAST_HEARTBEAT_AT_KEY);
  const lastSuccessAt = getSettingValue(WORKER_LAST_SUCCESS_AT_KEY);
  const lastErrorAt = getSettingValue(WORKER_LAST_ERROR_AT_KEY);
  const lastErrorMessage = getSettingValue(WORKER_LAST_ERROR_MESSAGE_KEY);
  // Status synchronization always runs in the worker, even without Kindle delivery.
  const expected = true;
  const lastHeartbeatMs = lastHeartbeatAt ? new Date(lastHeartbeatAt).getTime() : NaN;
  const running =
    Number.isFinite(lastHeartbeatMs) &&
    Date.now() - lastHeartbeatMs <= WORKER_FRESHNESS_WINDOW_MS;

  let message = "Automatic updates have stopped. Ask the person who manages Kindling to restart the app.";

  if (running && lastErrorAt && lastErrorMessage) {
    message = `Background work needs attention: ${lastErrorMessage}`;
  } else if (running) {
    message = "Background worker is running.";
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
