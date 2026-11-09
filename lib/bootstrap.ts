import { getAppConfig } from "@/lib/config";
import { initializeDatabase } from "@/lib/db/client";
import { createDeliveryService } from "@/lib/delivery/service";
import { runImportRescueCycle } from "@/lib/readarr/import-rescue";
import { createRequestService } from "@/lib/requests/service";
import {
  recordWorkerError,
  recordWorkerHeartbeat,
  recordWorkerStarted,
  recordWorkerStopped,
  recordWorkerSuccess,
} from "@/lib/worker-status";

type WatcherState = {
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  activeCycle: Promise<void> | null;
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
      heartbeatTimer: null,
      activeCycle: null,
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

export function startBackgroundWorker(onFatalError?: (error: unknown) => void) {
  const state = getWatcherState();
  if (state.started) {
    return;
  }

  initializeDatabase();

  const runCycle = async () => {
    try {
      const failures: string[] = [];

      try {
        await createRequestService().runAutomaticSearchRetryCycle();
      } catch (error) {
        failures.push(
          error instanceof Error ? error.message : "Automatic search retry cycle failed.",
        );
      }

      if (!state.started) return;
      try {
        await createRequestService().syncActiveRequests();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : "Request status update failed.");
      }

      if (!state.started) return;
      try {
        await runImportRescueCycle();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : "Stuck import check failed.");
      }

      if (!state.started) return;
      try {
        await createDeliveryService().runAutomaticWatchCycle();
      } catch (error) {
        failures.push(
          error instanceof Error ? error.message : "Automatic delivery cycle failed.",
        );
      }

      if (failures.length > 0) {
        console.error("[kindling worker]", failures.join(" | "));
        recordWorkerError(
          new Date().toISOString(),
          failures.join(" | "),
        );
      } else {
        recordWorkerSuccess(new Date().toISOString());
      }
    } finally {
      state.running = false;
      state.activeCycle = null;
    }
  };

  const handleFatalError = (error: unknown) => {
    console.error("[kindling worker] Worker failed:", error);
    void stopBackgroundWorker().catch((shutdownError) => {
      console.error("[kindling worker] Could not record shutdown:", shutdownError);
    });
    onFatalError?.(error);
  };

  const scheduleCycle = () => {
    if (!state.started || state.running) return;
    state.running = true;
    state.activeCycle = runCycle();
    // Database/status-write failures must terminate the standalone worker so its
    // supervisor can recover it, rather than leaving an unhandled rejection.
    void state.activeCycle.catch(handleFatalError);
  };

  recordWorkerStarted(new Date().toISOString());
  state.started = true;
  scheduleCycle();

  state.timer = setInterval(scheduleCycle, getAppConfig().delivery.scanIntervalMs);
  // A large library or a slow SMTP server can keep one cycle busy for minutes.
  // Heartbeats reflect process health independently of whether that cycle finished.
  state.heartbeatTimer = setInterval(() => {
    try {
      recordWorkerHeartbeat(new Date().toISOString());
    } catch (error) {
      handleFatalError(error);
    }
  }, 15_000);

  state.timer.unref?.();
  state.heartbeatTimer.unref?.();
}

export async function stopBackgroundWorker() {
  const state = getWatcherState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }

  state.started = false;
  await state.activeCycle;
  recordWorkerStopped(new Date().toISOString());
}
