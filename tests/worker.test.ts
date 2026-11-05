import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  retry: vi.fn(async () => {}),
  sync: vi.fn(async () => {}),
  delivery: vi.fn(async () => {}),
  heartbeat: vi.fn(),
  started: vi.fn(),
  stopped: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getAppConfig: () => ({ worker: { embedded: false }, delivery: { scanIntervalMs: 60_000 } }),
}));
vi.mock("@/lib/db/client", () => ({ initializeDatabase: vi.fn() }));
vi.mock("@/lib/requests/service", () => ({
  createRequestService: () => ({ runAutomaticSearchRetryCycle: deps.retry, syncActiveRequests: deps.sync }),
}));
vi.mock("@/lib/delivery/service", () => ({
  createDeliveryService: () => ({ runAutomaticWatchCycle: deps.delivery }),
}));
vi.mock("@/lib/worker-status", () => ({
  recordWorkerHeartbeat: deps.heartbeat,
  recordWorkerStarted: deps.started,
  recordWorkerStopped: deps.stopped,
  recordWorkerSuccess: deps.success,
  recordWorkerError: deps.error,
}));

import { startBackgroundWorker, stopBackgroundWorker } from "@/lib/bootstrap";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  globalThis.__kindlingWatcherState = undefined;
});

afterEach(async () => {
  await stopBackgroundWorker();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("background worker lifecycle", () => {
  it("reports heartbeats during a slow cycle and never overlaps cycles", async () => {
    let finish!: () => void;
    deps.retry.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    startBackgroundWorker();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(deps.heartbeat).toHaveBeenCalledTimes(8);
    expect(deps.retry).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.sync).toHaveBeenCalledOnce();
    expect(deps.delivery).toHaveBeenCalledOnce();
  });

  it("waits for active delivery to finish and prevents more cycles on shutdown", async () => {
    let finish!: () => void;
    deps.delivery.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    startBackgroundWorker();
    await vi.advanceTimersByTimeAsync(1);
    let stopped = false;
    const stopping = stopBackgroundWorker().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stopped).toBe(false);
    expect(deps.retry).toHaveBeenCalledTimes(1);
    finish();
    await stopping;
    expect(deps.stopped).toHaveBeenCalledOnce();
  });

  it("continues status sync and delivery after a retry failure, recording the failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    deps.retry.mockRejectedValueOnce(new Error("Readarr is offline"));
    startBackgroundWorker();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.sync).toHaveBeenCalledOnce();
    expect(deps.delivery).toHaveBeenCalledOnce();
    expect(deps.error).toHaveBeenCalledWith(expect.any(String), "Readarr is offline");
    expect(deps.success).not.toHaveBeenCalled();
  });

  it("stops scheduling and reports fatal heartbeat storage failures to the supervisor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("Database is unavailable");
    deps.heartbeat.mockImplementationOnce(() => { throw failure; });
    const onFatal = vi.fn();
    startBackgroundWorker(onFatal);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onFatal).toHaveBeenCalledExactlyOnceWith(failure);
    expect(deps.heartbeat).toHaveBeenCalledOnce();
    expect(deps.retry).toHaveBeenCalledOnce();
    expect(deps.stopped).toHaveBeenCalledOnce();
  });
});
