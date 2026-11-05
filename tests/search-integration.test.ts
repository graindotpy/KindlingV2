import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bootstrap: vi.fn(),
  ensureUsers: vi.fn(),
  search: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireApiSession: mocks.auth }));
vi.mock("@/lib/bootstrap", () => ({ ensureBackgroundServices: mocks.bootstrap }));
vi.mock("@/lib/users/service", () => ({ ensureDefaultUsers: mocks.ensureUsers }));
vi.mock("@/lib/requests/service", () => ({
  createRequestService: () => ({ searchBooksForUser: mocks.search }),
}));

import { GET } from "@/app/api/search/route";
import { resetAppConfigCache } from "@/lib/config";
import { resetOpenLibraryCache } from "@/lib/openlibrary/service";

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolved search integration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("OPENLIBRARY_CONTACT_EMAIL", "contact@example.com");
    resetAppConfigCache();
    resetOpenLibraryCache();
    mocks.auth.mockReturnValue(null);
    mocks.search.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetAppConfigCache();
    resetOpenLibraryCache();
  });

  it("reuses the candidate search, resolves its author ID, and sends that match to Readarr", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      expect(url.origin).toBe("https://openlibrary.org");
      expect(new Headers(init?.headers).get("User-Agent")).toBe(
        "Kindling/0.1 (contact@example.com)",
      );
      if (url.pathname === "/search.json") {
        return jsonResponse({
          docs: [
            {
              key: "/works/OL17450797W",
              title: "Prince of Thorns",
              author_key: ["OL6983136A"],
              author_name: ["Mark Lawrence"],
              first_publish_year: 2011,
            },
            {
              key: "/works/OL25857958W",
              title: "Prince of Thorns",
              author_key: ["OL9778743A"],
              author_name: ["Alexis Fegan Black"],
              first_publish_year: 2015,
            },
          ],
        });
      }
      if (url.pathname === "/authors/OL6983136A.json") {
        return jsonResponse({
          key: "/authors/OL6983136A",
          remote_ids: { goodreads: "4721536" },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstResponse = await GET(new NextRequest(
      "http://localhost/api/search?q=Prince%20of%20Thorns&userId=1&details=1",
    ));
    expect(await firstResponse.json()).toMatchObject({
      state: "choose",
      candidates: [
        { key: "OL17450797W", author: "Mark Lawrence" },
        { key: "OL25857958W", author: "Alexis Fegan Black" },
      ],
    });
    expect(mocks.search).not.toHaveBeenCalled();

    const selectedResponse = await GET(new NextRequest(
      "http://localhost/api/search?q=Prince%20of%20Thorns&userId=1&details=1&candidate=ol17450797w",
    ));
    expect(selectedResponse.status).toBe(200);
    expect(await selectedResponse.json()).toEqual({
      state: "results",
      results: [],
      warnings: [],
    });
    expect(mocks.search).toHaveBeenCalledWith(
      1,
      "author:4721536",
      expect.objectContaining({
        bookMatch: {
          authorForeignId: "4721536",
          targetTitle: "Prince of Thorns",
          alternateTitles: ["Prince of Thorns"],
          fallbackQuery: "Prince of Thorns",
        },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
