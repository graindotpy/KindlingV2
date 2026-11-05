import { expect, test, type Page } from "@playwright/test";
import type { BookRequestRecord, SearchResultItem } from "../../lib/requests/types";

const users = [
  { id: 1, name: "Alex", kindleEmail: "alex@kindle.com", createdAt: "2026-01-01", requestCount: 0 },
  { id: 2, name: "Sam", kindleEmail: null, createdAt: "2026-01-01", requestCount: 0 },
];
const source = { title: "The Borrowers", foreignBookId: "42", author: { foreignAuthorId: "7", authorName: "Mary Norton" } };
const result: SearchResultItem = {
  fingerprint: "book:42", title: source.title, author: "Mary Norton", year: 1952, coverUrl: null,
  actions: {
    ebook: { format: "ebook", availability: "requestable", availabilityLabel: "Ready to request", availabilityDescription: "Request this ebook.", request: null, source },
    audiobook: { format: "audiobook", availability: "unavailable", availabilityLabel: "Search unavailable", availabilityDescription: "Audiobook search is temporarily unavailable.", request: null, source: null },
  },
};
const saved: BookRequestRecord = {
  id: 10, userId: 1, userName: "Alex", requestFormat: "ebook", requestFingerprint: "book:42",
  requestedTitle: source.title, requestedAuthor: "Mary Norton", requestedYear: 1952,
  requestedAt: "2026-09-05T12:00:00Z", status: "requested", statusMessage: "Your request has been saved.",
  foreignAuthorId: "7", foreignBookId: "42", foreignEditionId: null, readarrAuthorId: 7, readarrBookId: 42,
  readarrEditionId: null, coverUrl: null, notes: null, searchAttemptCount: 0, nextSearchAttemptAt: null,
  lastSearchAttemptAt: null, lastSearchErrorMessage: null, lastSyncedAt: null, matchedFilePath: null,
  matchedAt: null, lastDeliveryAt: null, lastDeliveryRecipient: null, lastDeliveryTrigger: null,
  lastDeliveryMessage: null, createdAt: "2026-09-05T12:00:00Z", updatedAt: "2026-09-05T12:00:00Z",
};

async function mockHousehold(page: Page) {
  await page.route("**/api/users", (route) => route.fulfill({ json: users }));
  await page.route("**/api/settings/delivery", (route) => route.fulfill({ json: {
    watchDirectory: null, watchDirectoryState: "not-configured", watchDirectoryMessage: "Choose a delivery folder.",
    smtpConfigured: false, smtpState: "not-configured", smtpMessage: "Set up Kindle delivery in Household settings.",
    automaticDeliveryEnabled: false, worker: { expected: false, running: false, message: "Not enabled." },
  } }));
}

test("search can be repeated, warns about partial outages and requests the selected ebook", async ({ page }, testInfo) => {
  await mockHousehold(page);
  let searches = 0;
  await page.route("**/api/search?**", (route) => {
    searches++;
    return route.fulfill({ json: { results: [result], warnings: ["Audiobook search is temporarily unavailable."] } });
  });
  await page.route("**/api/requests", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ userId: 1, requestFormat: "ebook", selection: source });
    await route.fulfill({ status: 201, json: saved });
  });
  await page.goto("/");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(247, 247, 239)");
  const input = page.getByRole("searchbox");
  await expect(input).toBeEnabled();
  await expect(page.getByText("We couldn’t find that one")).toHaveCount(0);
  await input.fill("Borrowers");
  await input.press("Tab");
  expect(searches).toBe(0);
  await page.getByRole("button", { name: "Find a book", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The Borrowers", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Audiobook unavailable: The Borrowers" })).toBeDisabled();
  await page.getByRole("button", { name: "Find a book", exact: true }).click();
  await expect.poll(() => searches).toBe(2);
  await expect(page.getByRole("button", { name: "Request ebook: The Borrowers" })).toBeEnabled();
  await page.screenshot({ path: `test-results/${testInfo.project.name}-search.png`, fullPage: true });
  await page.getByRole("button", { name: "Request ebook: The Borrowers" }).click();
  await expect(page.getByRole("button", { name: "Ebook requested: The Borrowers" })).toBeDisabled();
  await expect(page.getByRole("link", { name: /View my books/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an ambiguous title asks for the exact book before searching Readarr", async ({ page }, testInfo) => {
  await mockHousehold(page);
  const candidates = [
    { key: "OL123W", title: "The Borrowers", author: "Mary Norton", year: 1952, coverUrl: null },
    { key: "OL789W", title: "Borrowers", author: "Terry Pratchett", year: 1983, coverUrl: null },
  ];
  let searches = 0;
  await page.route("**/api/search?**", async (route) => {
    searches++;
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("q")).toBe("Borrowers");
    if (!params.has("candidate")) {
      await route.fulfill({ json: { state: "choose", candidates, warnings: [] } });
      return;
    }
    expect(params.get("candidate")).toBe(candidates[0].key);
    await route.fulfill({ json: { state: "results", results: [result], warnings: [] } });
  });

  await page.goto("/");
  await page.getByRole("searchbox").fill("Borrowers");
  await page.getByRole("button", { name: "Find a book", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Did you mean…" })).toBeVisible();
  const chooser = page.getByRole("combobox", { name: "Choose the book" });
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  await expect(chooser).toContainText("The Borrowers — Mary Norton (1952)");
  await expect(chooser).toContainText("Borrowers — Terry Pratchett (1983)");
  await expect(continueButton).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/${testInfo.project.name}-disambiguation.png`, fullPage: true });

  await chooser.selectOption(candidates[0].key);
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  await expect.poll(() => searches).toBe(2);
  await expect(page.getByRole("heading", { name: "The Borrowers", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Did you mean…" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("changing query discards a slow result and a profile change clears old results", async ({ page }) => {
  await mockHousehold(page);
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.route("**/api/search?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === "Old query") await first;
    await route.fulfill({ json: { results: [result], warnings: [] } }).catch(() => {});
  });
  await page.goto("/");
  const input = page.getByRole("searchbox");
  await input.fill("Old query");
  await page.getByRole("button", { name: "Find a book", exact: true }).click();
  await expect(page.getByText("Looking for “Old query”…")).toBeVisible();
  await input.fill("Borrowers");
  releaseFirst();
  await page.getByRole("button", { name: "Find a book", exact: true }).click();
  await expect(page.getByRole("heading", { name: /1 match for “Borrowers”/ })).toBeVisible();
  await page.getByRole("combobox", { name: "Choose your household profile" }).selectOption("2");
  await expect(page.getByRole("heading", { name: "The Borrowers", exact: true })).toHaveCount(0);
});

test("an unavailable household can be retried without reloading the page", async ({ page }) => {
  let recovered = false;
  await page.route("**/api/users", (route) => !recovered
    ? route.fulfill({ status: 503, json: { message: "Household could not be loaded." } })
    : route.fulfill({ json: users }));
  await page.goto("/");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Household could not be loaded.");
  recovered = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("searchbox")).toBeEnabled();
});

test("removing a request updates the list and keeps the household library explanation visible", async ({ page }, testInfo) => {
  await mockHousehold(page);
  await page.route("**/api/requests?**", (route) => route.fulfill({ json: [saved] }));
  await page.route("**/api/requests/10", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    await route.fulfill({ json: { ...saved, status: "not-monitored" } });
  });
  await page.goto("/books");
  await expect(page.getByRole("heading", { name: "The Borrowers", exact: true })).toBeVisible();
  await page.getByText("Manage request", { exact: true }).click();
  await expect(page.getByText("Removing a request keeps the book in your library.")).toBeVisible();
  await page.screenshot({ path: `test-results/${testInfo.project.name}-books.png`, fullPage: true });
  await page.getByRole("button", { name: "Remove from list", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The Borrowers", exact: true })).toHaveCount(0);
});

test("real API requires a session and blocks cross-site account changes", async ({ request }) => {
  expect((await request.get("/api/users")).status()).toBe(401);
  expect((await request.post("/api/auth/session", { data: { password: "browser-test-password" }, headers: { origin: "https://untrusted.example" } })).status()).toBe(403);
  expect((await request.post("/api/auth/session", { data: { password: "browser-test-password" } })).status()).toBe(200);
  expect((await request.get("/api/users")).status()).toBe(200);
  expect((await request.delete("/api/auth/session")).status()).toBe(200);
  expect((await request.get("/api/users")).status()).toBe(401);
});

test("unlock explains missing setup without redirecting in a loop", async ({ page }, testInfo) => {
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { configured: false, authenticated: false } }));
  await page.goto("/unlock");
  await expect(page.getByRole("heading", { name: "A little setup first." })).toBeVisible();
  await expect(page.getByRole("button", { name: /Check again/ })).toBeEnabled();
  await expect(page).toHaveURL(/\/unlock$/);
  await page.screenshot({ path: `test-results/${testInfo.project.name}-unlock.png`, fullPage: true });
});

test("unlock handles a connection failure and can check again", async ({ page }) => {
  let recovered = false;
  await page.route("**/api/auth/session", (route) => !recovered
    ? route.abort("connectionrefused")
    : route.fulfill({ json: { configured: true, authenticated: false } }));
  await page.goto("/unlock");
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  recovered = true;
  await page.getByRole("button", { name: "Check connection again" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Household password")).toBeVisible();
});
