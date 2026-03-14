import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppConfigCache } from "@/lib/config";
import { createReadarrService } from "@/lib/readarr/service";

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createReadarrService.searchBooks", () => {
  beforeEach(() => {
    process.env.READARR_BASE_URL = "http://localhost:8787";
    process.env.READARR_API_KEY = "test-api-key";
    resetAppConfigCache();
    vi.restoreAllMocks();
  });

  it("enriches lightweight book lookup results with author records", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();

      if (url.includes("/api/v1/book/lookup")) {
        return jsonResponse([
          {
            title: "The Way of Kings",
            authorTitle: "sanderson, brandon The Way of Kings",
            foreignBookId: "8134945",
            foreignEditionId: "7235533",
            titleSlug: "8134945",
            monitored: false,
            anyEditionOk: true,
            releaseDate: "2010-08-31T06:00:00Z",
            images: [],
            remoteCover: "/cover.jpg",
          },
        ]);
      }

      if (url.includes("/api/v1/author/lookup")) {
        return jsonResponse([
          {
            id: 38550,
            authorName: "Brandon Sanderson",
            authorNameLastFirst: "Sanderson, Brandon",
            foreignAuthorId: "38550",
            titleSlug: "38550",
          },
        ]);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const results = await createReadarrService().searchBooks("Sanderson");

    expect(results).toHaveLength(1);
    expect(results[0]?.author.authorName).toBe("Brandon Sanderson");
    expect(results[0]?.author.foreignAuthorId).toBe("38550");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips only the author rows that fail Goodreads lookup", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      const parsedUrl = new URL(url);
      const term = parsedUrl.searchParams.get("term");

      if (url.includes("/api/v1/book/lookup")) {
        return jsonResponse([
          {
            title: "Between Two Fires",
            authorTitle: "buehlman, christopher Between Two Fires",
            foreignBookId: "19107416",
            foreignEditionId: "13543121",
            titleSlug: "19107416",
            monitored: false,
            anyEditionOk: true,
            releaseDate: "2012-10-02T06:00:00Z",
            images: [],
            remoteCover: "/cover.jpg",
          },
          {
            title: "Between Two Fires",
            authorTitle: "williams, toni Between Two Fires",
            foreignBookId: "48107781",
            foreignEditionId: "29203078",
            titleSlug: "48107781",
            monitored: false,
            anyEditionOk: true,
            releaseDate: "2016-02-15T08:00:00Z",
            images: [],
            remoteCover: "/cover-2.jpg",
          },
        ]);
      }

      if (
        parsedUrl.pathname.endsWith("/api/v1/author/lookup") &&
        term?.toLowerCase() === "christopher buehlman"
      ) {
        return jsonResponse([
          {
            id: 4712375,
            authorName: "Christopher Buehlman",
            authorNameLastFirst: "Buehlman, Christopher",
            foreignAuthorId: "4712375",
            titleSlug: "4712375",
          },
        ]);
      }

      if (
        parsedUrl.pathname.endsWith("/api/v1/author/lookup") &&
        term?.toLowerCase() === "toni williams"
      ) {
        return new Response(
          JSON.stringify({
            message: "Search for 'toni williams' failed. Invalid response received from Goodreads.",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const results = await createReadarrService().searchBooks("Between Two Fires");

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Between Two Fires");
    expect(results[0]?.author.authorName).toBe("Christopher Buehlman");
  });
});
