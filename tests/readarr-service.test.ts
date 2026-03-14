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

describe("createReadarrService.addBookForRequest", () => {
  beforeEach(() => {
    process.env.READARR_BASE_URL = "http://localhost:8787";
    process.env.READARR_API_KEY = "test-api-key";
    resetAppConfigCache();
    vi.restoreAllMocks();
  });

  it("recovers when Readarr partially creates a book before returning a 500", async () => {
    vi.useFakeTimers();

    const selection = {
      id: 0,
      title: "A Game of Thrones",
      foreignBookId: "goodreads:13496",
      foreignEditionId: "edition:1",
      releaseDate: "1996-08-06T00:00:00.000Z",
      author: {
        id: 51,
        authorName: "George R.R. Martin",
        foreignAuthorId: "goodreads-author:346732",
      },
      editions: [{ id: 81, monitored: true, isEbook: true }],
      statistics: { bookFileCount: 0 },
    };

    const createdBook = {
      ...selection,
      id: 1466917,
      monitored: true,
    };

    let authorBooksLookups = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();

      if (url.endsWith("/api/v1/rootfolder")) {
        return jsonResponse([
          {
            path: "/books",
            defaultQualityProfileId: 1,
            defaultMetadataProfileId: 2,
          },
        ]);
      }

      if (url.endsWith("/api/v1/qualityprofile")) {
        return jsonResponse([{ id: 1 }]);
      }

      if (url.endsWith("/api/v1/metadataprofile")) {
        return jsonResponse([{ id: 2 }]);
      }

      if (url.includes("/api/v1/book?authorId=51")) {
        authorBooksLookups += 1;
        return jsonResponse(authorBooksLookups >= 3 ? [createdBook] : []);
      }

      if (url.endsWith("/api/v1/book") && init?.method === "POST") {
        return new Response(JSON.stringify({ message: "Readarr blew up after create." }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const pending = createReadarrService().addBookForRequest(selection as never);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.id).toBe(1466917);
    expect(authorBooksLookups).toBe(3);
    vi.useRealTimers();
  });

  it("normalizes missing editions before posting a new book to Readarr", async () => {
    const selection = {
      id: 0,
      title: "A Game of Thrones",
      foreignBookId: "goodreads:13496",
      foreignEditionId: "edition:1",
      releaseDate: "1996-08-06T00:00:00.000Z",
      author: {
        id: 51,
        authorName: "George R.R. Martin",
        foreignAuthorId: "goodreads-author:346732",
      },
      statistics: { bookFileCount: 0 },
    };

    let postedBody: unknown = null;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();

      if (url.endsWith("/api/v1/rootfolder")) {
        return jsonResponse([
          {
            path: "/books",
            defaultQualityProfileId: 1,
            defaultMetadataProfileId: 2,
          },
        ]);
      }

      if (url.endsWith("/api/v1/qualityprofile")) {
        return jsonResponse([{ id: 1 }]);
      }

      if (url.endsWith("/api/v1/metadataprofile")) {
        return jsonResponse([{ id: 2 }]);
      }

      if (url.includes("/api/v1/book?authorId=51")) {
        return jsonResponse([]);
      }

      if (url.endsWith("/api/v1/book") && init?.method === "POST") {
        postedBody = JSON.parse(String(init.body));
        return jsonResponse({
          ...selection,
          id: 101,
          monitored: true,
          editions: [],
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await createReadarrService().addBookForRequest(selection as never);

    expect(result.id).toBe(101);
    expect(postedBody).toMatchObject({
      title: "A Game of Thrones",
      editions: [],
    });
  });
});
