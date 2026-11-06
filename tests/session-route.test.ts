import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/auth/session/route";
import { resetAppConfigCache } from "@/lib/config";
import {
  getUnlockRetryAfterSeconds,
  recordUnlockFailure,
  resetUnlockRateLimit,
} from "@/lib/auth-rate-limit";

function unlock(password: string, client = "203.0.113.5") {
  return POST(new Request("http://localhost/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": client },
    body: JSON.stringify({ password }),
  }));
}

describe("unlock rate limiting", () => {
  beforeEach(() => {
    process.env.KINDLING_ADMIN_PASSWORD = "open-sesame";
    process.env.KINDLING_SESSION_SECRET = "session-secret";
    resetAppConfigCache();
    resetUnlockRateLimit();
  });

  afterEach(() => {
    delete process.env.KINDLING_ADMIN_PASSWORD;
    delete process.env.KINDLING_SESSION_SECRET;
    resetAppConfigCache();
    resetUnlockRateLimit();
  });

  it("blocks a client after five incorrect passwords, even with the right one", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await unlock("wrong")).status).toBe(401);
    }

    const blocked = await unlock("open-sesame");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("set-cookie")).toBeNull();
  });

  it("enforces the limit on concurrent attempts", async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => unlock("wrong")));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
  });

  it("enforces the household ceiling on concurrent attempts from many addresses", async () => {
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) => unlock("wrong", `192.0.2.${index}`)),
    );
    expect(responses.filter((response) => response.status === 401)).toHaveLength(30);
  });

  it("does not block other clients for one client's failures", async () => {
    for (let attempt = 0; attempt < 5; attempt++) await unlock("wrong");
    expect((await unlock("open-sesame", "198.51.100.9")).status).toBe(200);
  });

  it("clears a client's failures after a successful unlock", async () => {
    for (let attempt = 0; attempt < 4; attempt++) await unlock("wrong");
    expect((await unlock("open-sesame")).status).toBe(200);
    expect((await unlock("wrong")).status).toBe(401);
    expect((await unlock("open-sesame")).status).toBe(200);
  });

  it("applies a household-wide ceiling when addresses keep changing", async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      await unlock("wrong", `192.0.2.${attempt}`);
    }
    expect((await unlock("open-sesame", "192.0.2.200")).status).toBe(429);
  });

  it("allows attempts again once the window has passed", () => {
    for (let attempt = 0; attempt < 5; attempt++) recordUnlockFailure("client", 0);
    expect(getUnlockRetryAfterSeconds("client", 1_000)).toBeGreaterThan(0);
    expect(getUnlockRetryAfterSeconds("client", 15 * 60_000 + 1)).toBeNull();
  });
});
