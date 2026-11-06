// Limits failed unlock attempts. Kindling has one shared household password,
// so unlimited guesses would make it the weakest point when the app is
// reachable through a reverse proxy.
//
// Two windows apply:
// - per client, keyed by the first forwarded address (or "direct"), and
// - a household-wide ceiling, because forwarded headers can be spoofed when
//   Kindling is reached without a proxy.
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_CLIENT = 5;
const MAX_FAILURES_TOTAL = 30;
const MAX_TRACKED_CLIENTS = 1_000;
const TOTAL_KEY = "\u0000total";

type FailureWindow = {
  count: number;
  resetAt: number;
};

declare global {
  var __kindlingUnlockFailures: Map<string, FailureWindow> | undefined;
}

function getStore() {
  globalThis.__kindlingUnlockFailures ??= new Map();
  return globalThis.__kindlingUnlockFailures;
}

function getWindow(key: string, now: number) {
  const entry = getStore().get(key);
  if (!entry || entry.resetAt <= now) return null;
  return entry;
}

export function getUnlockClientKey(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  return (forwarded || realIp || "direct").slice(0, 100);
}

/** Returns the number of seconds to wait, or null when another attempt is allowed. */
export function getUnlockRetryAfterSeconds(clientKey: string, now = Date.now()) {
  const client = getWindow(clientKey, now);
  const total = getWindow(TOTAL_KEY, now);
  const blockedUntil = Math.max(
    client && client.count >= MAX_FAILURES_PER_CLIENT ? client.resetAt : 0,
    total && total.count >= MAX_FAILURES_TOTAL ? total.resetAt : 0,
  );
  return blockedUntil > now ? Math.ceil((blockedUntil - now) / 1000) : null;
}

function increment(key: string, now: number) {
  const store = getStore();
  const current = getWindow(key, now);
  store.set(key, current
    ? { count: current.count + 1, resetAt: current.resetAt }
    : { count: 1, resetAt: now + WINDOW_MS });
}

export function recordUnlockFailure(clientKey: string, now = Date.now()) {
  const store = getStore();
  if (store.size > MAX_TRACKED_CLIENTS) {
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }
  if (store.size <= MAX_TRACKED_CLIENTS || store.has(clientKey)) {
    increment(clientKey, now);
  }
  increment(TOTAL_KEY, now);
}

export function recordUnlockSuccess(clientKey: string) {
  getStore().delete(clientKey);
}

export function resetUnlockRateLimit() {
  getStore().clear();
}
