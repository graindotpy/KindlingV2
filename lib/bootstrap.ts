import { getAppConfig } from "@/lib/config";
import { initializeDatabase } from "@/lib/db/client";
import { createDeliveryService } from "@/lib/delivery/service";
import {
  recordWorkerError,
  recordWorkerHeartbeat,
  recordWorkerStarted,
  recordWorkerSuccess,
} from "@/lib/worker-status";

type WatcherState = {
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
};

declare global {
  var __kindlingWatcherState: WatcherState | undefined;
}

function getWatcherState(): WatcherState {
  if (!globalThis.__kindlingWatcherState) {
    globalThis.__kindlingWatcherState = {
      started: false,
      running: false,
      timer: null,
    };
  }

  return globalThis.__kindlingWatcherState;
}

export function ensureBackgroundServices() {
  if (!getAppConfig().worker.embedded) {
    return;
  }

  startBackgroundWorker();
}

export function startBackgroundWorker() {
  const state = getWatcherState();
  if (state.started) {
    return;
  }

  initializeDatabase();

  const runCycle = async () => {
    if (state.running) {
      return;
    }

    state.running = true;
    const startedAt = new Date().toISOString();
    recordWorkerHeartbeat(startedAt);

    try {
      await createDeliveryService().runAutomaticWatchCycle();
      recordWorkerSuccess(new Date().toISOString());
    } catch (error) {
      recordWorkerError(
        new Date().toISOString(),
        error instanceof Error ? error.message : "Automatic delivery worker failed.",
      );
    } finally {
      state.running = false;
    }
  };

  state.started = true;
  recordWorkerStarted(new Date().toISOString());
  void runCycle();

  state.timer = setInterval(() => {
    void runCycle();
  }, getAppConfig().delivery.scanIntervalMs);

  state.timer.unref?.();
}

export function stopBackgroundWorker() {
  const state = getWatcherState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  state.started = false;
  state.running = false;
}
