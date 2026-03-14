import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createSettingsRepository } from "@/lib/db/repositories/settings";
import { createSmtpMailer } from "@/lib/delivery/mailer";
import type {
  DeliverySettings,
  DeliveryWatchDirectoryState,
} from "@/lib/delivery/types";
import { getBackgroundWorkerStatus } from "@/lib/worker-status";

const WATCH_DIRECTORY_KEY = "delivery.watchDirectory";

function normalizeWatchDirectory(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

export function getStoredWatchDirectory() {
  const settingsRepository = createSettingsRepository();
  const watchDirectorySetting = settingsRepository.get(WATCH_DIRECTORY_KEY);
  return normalizeWatchDirectory(watchDirectorySetting?.value);
}

async function inspectWatchDirectory(
  watchDirectory: string | null,
): Promise<{
  state: DeliveryWatchDirectoryState;
  message: string;
}> {
  if (!watchDirectory) {
    return {
      state: "not-configured",
      message: "Choose a watched folder to enable automatic file matching.",
    };
  }

  try {
    const stats = await fs.stat(watchDirectory);
    if (!stats.isDirectory()) {
      return {
        state: "invalid",
        message: "That watched path exists, but it is not a folder.",
      };
    }

    await fs.access(watchDirectory, fsConstants.R_OK);

    return {
      state: "ready",
      message: "Watched folder is mounted and readable.",
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return {
        state: "missing",
        message: "Kindling cannot see that folder. Check the path or Docker bind mount.",
      };
    }

    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM")
    ) {
      return {
        state: "invalid",
        message: "Kindling does not have permission to read that folder.",
      };
    }

    return {
      state: "invalid",
      message:
        error instanceof Error
          ? error.message
          : "Kindling could not validate that watched folder.",
    };
  }
}

export async function getDeliverySettings(): Promise<DeliverySettings> {
  const watchDirectory = getStoredWatchDirectory();
  const mailer = createSmtpMailer();
  const [watchDirectoryStatus, smtpStatus] = await Promise.all([
    inspectWatchDirectory(watchDirectory),
    mailer.checkConnection(),
  ]);
  const worker = getBackgroundWorkerStatus();
  const smtpConfigured = smtpStatus.configured && smtpStatus.reachable;

  return {
    watchDirectory,
    watchDirectoryState: watchDirectoryStatus.state,
    watchDirectoryMessage: watchDirectoryStatus.message,
    smtpConfigured,
    smtpState: !smtpStatus.configured ? "not-configured" : smtpStatus.reachable ? "ready" : "error",
    smtpMessage: smtpStatus.message,
    automaticDeliveryEnabled:
      watchDirectoryStatus.state === "ready" &&
      smtpConfigured &&
      (!worker.expected || worker.running),
    worker,
  };
}

export function getDeliveryRuntimeSettings() {
  return {
    watchDirectory: getStoredWatchDirectory(),
  };
}

export async function updateDeliverySettings(input: { watchDirectory: string | null }) {
  const normalized = normalizeWatchDirectory(input.watchDirectory);
  const settingsRepository = createSettingsRepository();
  const updatedAt = new Date().toISOString();

  if (normalized) {
    const status = await inspectWatchDirectory(normalized);
    if (status.state !== "ready") {
      throw new Error(status.message);
    }
  }

  settingsRepository.set(WATCH_DIRECTORY_KEY, normalized, updatedAt);

  return getDeliverySettings();
}
