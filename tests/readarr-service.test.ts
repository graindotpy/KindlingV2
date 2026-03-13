import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
