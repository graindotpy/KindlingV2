import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), bootstrap: vi.fn(), ensureUsers: vi.fn(), search: vi.fn(), resolve: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireApiSession: mocks.auth }));
vi.mock("@/lib/bootstrap", () => ({ ensureBackgroundServices: mocks.bootstrap }));
vi.mock("@/lib/users/service", () => ({ ensureDefaultUsers: mocks.ensureUsers }));
vi.mock("@/lib/requests/service", () => ({ createRequestService: () => ({ searchBooksForUser: mocks.search }) }));
vi.mock("@/lib/search/resolver", () => ({
  createSearchResolver: () => ({ resolve: mocks.resolve }),
  SearchResolutionError: class SearchResolutionError extends Error {
    status = 400;
  },
}));

import { GET } from "@/app/api/search/route";

describe("search API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockReturnValue(null);
    mocks.search.mockResolvedValue([]);
    mocks.resolve.mockResolvedValue({
      state: "search",
      readarrQuery: "Borrowers",
      bookMatch: null,
      warnings: [],
    });
  });

  it("returns an explicit partial-search warning and the requested format", async () => {
    mocks.search.mockImplementation(async (_userId, _query, options) => {
      options.onWarnings(["Audiobook catalogue is unavailable."]);
      return [{ title: "The Borrowers" }];
    });
    const response = await GET(new NextRequest("http://localhost/api/search?q=Borrowers&userId=1&format=audiobook&details=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ state: "results", results: [{ title: "The Borrowers" }], warnings: ["Audiobook catalogue is unavailable."] });
    expect(mocks.search).toHaveBeenCalledWith(1, "Borrowers", expect.objectContaining({ format: "audiobook", bookMatch: null }));
  });

  it("keeps the existing array response for older clients", async () => {
    const response = await GET(new NextRequest("http://localhost/api/search?q=Borrowers&userId=1"));
    expect(await response.json()).toEqual([]);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each(["q=&userId=1", "q=Borrowers&userId=abc", "q=Borrowers&userId=1&format=paperback", "q=Borrowers&userId=1&candidate=unsafe", `q=${"a".repeat(301)}&userId=1`])("rejects invalid input before doing work: %s", async (query) => {
    const response = await GET(new NextRequest(`http://localhost/api/search?${query}`));
    expect(response.status).toBe(400);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("checks authentication before starting background work", async () => {
    mocks.auth.mockReturnValue(NextResponse.json({ message: "Sign in" }, { status: 401 }));
    const response = await GET(new NextRequest("http://localhost/api/search?q=Borrowers&userId=1"));
    expect(response.status).toBe(401);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.ensureUsers).not.toHaveBeenCalled();
  });

  it("reports a search outage as an error rather than a successful empty list", async () => {
    mocks.search.mockRejectedValue(new Error("Readarr took too long to respond."));
    const response = await GET(new NextRequest("http://localhost/api/search?q=Borrowers&userId=1&details=1"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Readarr took too long to respond." });
  });

  it("returns Open Library choices without searching Readarr", async () => {
    mocks.resolve.mockResolvedValueOnce({
      state: "choose",
      candidates: [{
        key: "OL17450797W",
        title: "Prince of Thorns",
        author: "Mark Lawrence",
        year: 2011,
        coverUrl: null,
      }],
      warnings: [],
    });

    const response = await GET(new NextRequest(
      "http://localhost/api/search?q=Prince%20of%20Thorns&userId=1&details=1",
    ));

    expect(await response.json()).toMatchObject({
      state: "choose",
      candidates: [{ key: "OL17450797W", author: "Mark Lawrence" }],
    });
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("revalidates the selected Open Library work and passes its author match to Readarr", async () => {
    const bookMatch = {
      authorForeignId: "4721536",
      targetTitle: "Prince of Thorns",
      alternateTitles: ["Prince of Thorns"],
      fallbackQuery: "Prince of Thorns",
    };
    mocks.resolve.mockResolvedValueOnce({
      state: "search",
      readarrQuery: "author:4721536",
      bookMatch,
      warnings: ["Resolver warning"],
    });

    const response = await GET(new NextRequest(
      "http://localhost/api/search?q=Prince%20of%20Thorns&userId=1&candidate=OL17450797W&details=1",
    ));

    expect(mocks.resolve).toHaveBeenCalledWith(
      "Prince of Thorns",
      "OL17450797W",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.search).toHaveBeenCalledWith(
      1,
      "author:4721536",
      expect.objectContaining({ bookMatch }),
    );
    expect(await response.json()).toEqual({
      state: "results",
      results: [],
      warnings: ["Resolver warning"],
    });
  });
});
