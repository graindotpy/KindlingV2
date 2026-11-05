import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => new Map<string, string | null>());
vi.mock("@/lib/db/repositories/settings", () => ({
  createSettingsRepository: () => ({
    get: (key: string) => settings.has(key) ? { value: settings.get(key) } : null,
    set: (key: string, value: string | null) => settings.set(key, value),
  }),
}));

import {
  getBackgroundWorkerStatus,
  recordWorkerStarted,
  recordWorkerStopped,
  recordWorkerError,
} from "@/lib/worker-status";

beforeEach(() => {
  settings.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("background worker health", () => {
  it("expects status synchronization even without delivery settings or queued retries", () => {
    expect(getBackgroundWorkerStatus()).toMatchObject({ expected: true, running: false });
    recordWorkerStarted(new Date().toISOString());
    expect(getBackgroundWorkerStatus().running).toBe(true);
    vi.advanceTimersByTime(90_001);
    expect(getBackgroundWorkerStatus().running).toBe(false);
  });

  it("distinguishes a provider failure from an unavailable worker, and records shutdown", () => {
    recordWorkerStarted(new Date().toISOString());
    recordWorkerError(new Date().toISOString(), "Readarr is offline");
    expect(getBackgroundWorkerStatus()).toMatchObject({
      running: true,
      lastErrorMessage: "Readarr is offline",
      message: "Background work needs attention: Readarr is offline",
    });
    recordWorkerStopped(new Date().toISOString());
    expect(getBackgroundWorkerStatus().running).toBe(false);
  });
});
