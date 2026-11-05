/** Shared browser transport with bounded waits and a single unlock flow. */
export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 45000);
  const cancel = () => controller.abort();
  if (init?.signal?.aborted) controller.abort();
  init?.signal?.addEventListener("abort", cancel, { once: true });

  try {
    const response = await fetch(input, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
      // Discard stale household state and in-flight requests when the session expires.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/unlock?next=${next}`);
      throw new Error("Please unlock Kindling to continue.");
    }
    if (!response.ok) {
      throw new Error(payload?.message ?? "Kindling could not finish that. Please try again.");
    }
    if (payload === null) throw new Error("Kindling returned an empty response. Please try again.");
    return payload as T;
  } catch (error) {
    if (timedOut) throw new Error("This is taking longer than expected. Please try again.");
    if (error instanceof TypeError) throw new Error("We could not reach Kindling. Check your connection and try again.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", cancel);
  }
}
