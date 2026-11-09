import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppConfigCache } from "@/lib/config";
import { createReadarrService, pickBestCoverUrl } from "@/lib/readarr/service";
import type { ReadarrLookupBook } from "@/lib/readarr/types";

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetAppConfigCache();
});

function book(overrides: Partial<ReadarrLookupBook> = {}): ReadarrLookupBook {
  return {
    title: "The Borrowers",
    foreignBookId: "42",
    author: { authorName: "Mary Norton", foreignAuthorId: "9" },
    ...overrides,
  };
}

describe("Readarr search reliability", () => {
  beforeEach(() => {
    vi.stubEnv("READARR_BASE_URL", "http://localhost:8787");
    vi.stubEnv("READARR_API_KEY", "test-api-key");
    resetAppConfigCache();
  });

  it("uses Readarr's complete search resources without extra author lookups", async () => {
    const complete = book({ editions: [{ foreignEditionId: "81", isbn13: "9780152047375" }] });
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(new URL(input).pathname).toBe("/api/v1/search");
      return jsonResponse([{ author: book().author }, { book: complete }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await createReadarrService().searchBooks("Borrowers")).toEqual([complete]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves lightweight results by exact work ID rather than a similar author name", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith("search")) return new Response(null, { status: 404 });
      if (url.pathname.endsWith("author/lookup")) {
        expect(url.searchParams.get("term")).toBe("work:42");
        return jsonResponse([book().author]);
      }
      return jsonResponse([{ title: "The Borrowers", foreignBookId: "42", authorTitle: "norton, mary The Borrowers" }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await createReadarrService().searchBooks("The Borrowers");
    expect(results[0]?.author).toEqual(book().author);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports unverifiable author details instead of choosing the first author", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith("author/lookup")) {
        return jsonResponse([]);
      }
      if (url.pathname.endsWith("book") || url.searchParams.get("term") === "work:42") return jsonResponse([]);
      return jsonResponse([{ title: "The Borrowers", foreignBookId: "42", authorTitle: "norton, mary The Borrowers" }]);
    }));
    await expect(createReadarrService().searchBooks("The Borrowers")).rejects.toThrow("could not verify book details");
  });

  it("does not guess between two authors with the same name", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith("author/lookup")) {
        return jsonResponse([{ authorName: "Mary Norton", foreignAuthorId: "9" }, { authorName: "Mary Norton", foreignAuthorId: "99" }]);
      }
      if (url.pathname.endsWith("book") || url.searchParams.get("term") === "work:42") return jsonResponse([]);
      return jsonResponse([{ title: "The Borrowers", foreignBookId: "42", authorTitle: "norton, mary The Borrowers" }]);
    }));
    await expect(createReadarrService().searchBooks("The Borrowers")).rejects.toThrow("could not verify book details");
  });

  it("enriches a named author whose foreign ID is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      if (new URL(input).pathname.endsWith("author/lookup")) return jsonResponse([book().author]);
      return jsonResponse([book({ author: { authorName: "Mary Norton", foreignAuthorId: "" } })]);
    }));
    expect((await createReadarrService().searchBooks("Borrowers"))[0]?.author.foreignAuthorId).toBe("9");
  });

  it("preserves the URL base and uses the audiobook instance's API key", async () => {
    vi.stubEnv("AUDIOBOOK_READARR_BASE_URL", "http://localhost:9797/audiobooks/");
    vi.stubEnv("AUDIOBOOK_READARR_API_KEY", "audio-key");
    resetAppConfigCache();
    const fetchMock = vi.fn(async () => jsonResponse([{ book: book() }]));
    vi.stubGlobal("fetch", fetchMock);
    await createReadarrService("audiobook").searchBooks("Borrowers");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://localhost:9797/audiobooks/api/v1/search?term=Borrowers"),
      expect.objectContaining({ headers: expect.objectContaining({ "X-Api-Key": "audio-key" }) }),
    );
  });

  it("falls back to matching library books and joins local author IDs during a metadata outage", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith("book/lookup")) return new Response(JSON.stringify({ message: "Goodreads failed" }), { status: 500 });
      if (url.pathname.endsWith("author")) return jsonResponse([{ ...book().author, id: 7 }]);
      return jsonResponse([
        { id: 10, title: "The Borrowers", foreignBookId: "42", authorId: 7 },
        book({ id: 11, title: "Unrelated novel", foreignBookId: "43" }),
      ]);
    }));
    const results = await createReadarrService().searchBooksWithDiagnostics("Bórrówers Norton");
    expect(results.books).toHaveLength(1);
    expect(results.books[0]?.id).toBe(10);
    expect(results.source).toBe("library");
    expect(results.warnings.join(" ")).toContain("New books may be missing");
  });

  it("warns when Readarr silently returns no catalogue results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const results = await createReadarrService().searchBooksWithDiagnostics("Nothing here");
    expect(results.books).toEqual([]);
    expect(results.warnings.join(" ")).toContain("metadata provider");
  });

  it("reuses a short-lived library snapshot across search requests during a catalogue outage", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith("book")) return jsonResponse([book({ id: 10 })]);
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    await createReadarrService().searchBooks("Borrowers");
    await createReadarrService().searchBooks("Mary Norton");
    expect(fetchMock.mock.calls.filter(([input]) => new URL(input).pathname.endsWith("book"))).toHaveLength(1);
  });

  it("retains partial results without warning about rows it had to skip", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      return url.pathname.endsWith("book/lookup") && url.searchParams.get("term") === "Borrowers"
        ? jsonResponse([book(), { title: "Unknown", foreignBookId: "43" }]) : jsonResponse([]);
    }));
    const results = await createReadarrService().searchBooksWithDiagnostics("Borrowers");
    expect(results.books).toEqual([book()]);
    expect(results.warnings).toEqual([]);
  });

  it("deduplicates works and ranks exact title matches first", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([
      book({ title: "The Borrowers Afloat", foreignBookId: "43" }),
      book(), book({ id: 10 }),
    ])));
    const results = await createReadarrService().searchBooks("The Borrowers");
    expect(results.map((entry) => entry.foreignBookId)).toEqual(["42", "43"]);
    expect(results[0]?.id).toBe(10);
  });

  it("rejects malformed successful responses instead of treating them as an empty search", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) =>
      new URL(input).pathname.endsWith("book/lookup") ? jsonResponse({ unexpected: true }) : jsonResponse([])));
    await expect(createReadarrService().searchBooks("Borrowers")).rejects.toThrow("invalid book catalogue response");
  });

  it("bounds unreachable Readarr requests and provides an actionable timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      })));
    const pending = createReadarrService().searchBooks("Borrowers");
    const assertion = expect(pending).rejects.toThrow("took too long");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("points a timed-out search at Readarr's metadata provider", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      })));
    const plain = createReadarrService().searchBooks("Gardens of the Moon");
    const resolved = createReadarrService().searchBooksByAuthorWithDiagnostics({
      authorForeignId: "31232",
      targetTitle: "Gardens of the Moon",
      fallbackQuery: "gardens of the moon",
    });
    const assertions = [
      expect(plain).rejects.toThrow("metadata provider is probably slow or down"),
      expect(resolved).rejects.toThrow("metadata provider is probably slow or down"),
    ];
    await vi.runAllTimersAsync();
    await Promise.all(assertions);
  });

  it("keeps upstream HTML, API keys, and stack traces out of user-facing errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>test-api-key stack trace</html>", { status: 401 })));
    await expect(createReadarrService().searchBooks("Borrowers")).rejects.toThrow("Readarr rejected the API key");
    await expect(createReadarrService().searchBooks("Borrowers")).rejects.not.toThrow("test-api-key");
  });

  it("prefers an actual remote cover over a broken local Readarr path", () => {
    expect(pickBestCoverUrl({ remoteCover: "/MediaCover/1.jpg", images: [{ remoteUrl: "https://example.com/cover.jpg" }] })).toBe("https://example.com/cover.jpg");
    expect(pickBestCoverUrl({ remoteCover: "javascript:alert(1)" })).toBeNull();
  });
});

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
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
        term === "work:19107416"
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
        term === "work:48107781"
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

describe("createReadarrService resolved author search", () => {
  beforeEach(() => {
    vi.stubEnv("READARR_BASE_URL", "http://localhost:8787");
    vi.stubEnv("READARR_API_KEY", "test-api-key");
    resetAppConfigCache();
  });

  it("uses the Goodreads author ID as the lookup term and filters the full corpus before the result cap", async () => {
    const author = {
      authorName: "Mark Lawrence",
      foreignAuthorId: "4721536",
    };
    const target = book({
      title: "Prince of Thorns",
      foreignBookId: "9579634",
      author,
    });
    const corpus = [
      ...Array.from({ length: 75 }, (_, index) => book({
        title: `Unrelated Work ${index + 1}`,
        foreignBookId: String(index + 1),
        author,
      })),
      target,
    ];
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/api/v1/search");
      expect(url.searchParams.get("term")).toBe("author:4721536");
      return jsonResponse(corpus.map((entry) => ({ book: entry })));
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await createReadarrService().searchBooksByAuthor({
      authorForeignId: "4721536",
      targetTitle: "Prince of Thorns",
      fallbackQuery: "Prince of Thorns",
    });

    expect(results).toEqual([target]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["empty", "error"] as const)(
    "uses the exact original query after an %s author-catalogue result",
    async (authorResult) => {
      const expected = book({
        title: "The Traitor Baru Cormorant",
        foreignBookId: "43007917",
        author: { authorName: "Seth Dickinson", foreignAuthorId: "5760737" },
      });
      const searchTerms: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        if (url.pathname === "/api/v1/search") {
          const term = url.searchParams.get("term") ?? "";
          searchTerms.push(term);
          if (term === "author:5760737") {
            return authorResult === "error"
              ? new Response(JSON.stringify({ message: "BookInfo failed" }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
              })
              : jsonResponse([]);
          }
          if (term === "Baru Cormorant") {
            return jsonResponse([{ book: expected }]);
          }
        }
        if (url.pathname === "/api/v1/book/lookup") return jsonResponse([]);
        if (url.pathname === "/api/v1/book") return jsonResponse([]);
        throw new Error(`Unexpected fetch: ${url}`);
      }));

      const response = await createReadarrService().searchBooksByAuthorWithDiagnostics({
        authorForeignId: "5760737",
        targetTitle: "The Traitor Baru Cormorant",
        alternateTitles: ["Baru Cormorant"],
        fallbackQuery: "Baru Cormorant",
      });

      expect(response.books).toEqual([expected]);
      expect(response.warnings).toEqual([]);
      expect(searchTerms).toEqual(["author:5760737", "Baru Cormorant"]);
      expect(searchTerms).not.toContain("The Traitor Baru Cormorant");
    },
  );

  it("filters exact-query fallback results by both selected title and Goodreads author ID", async () => {
    const expected = book({
      title: "The Traitor Baru Cormorant",
      foreignBookId: "43007917",
      author: {
        authorName: "Seth Dickinson",
        foreignAuthorId: "goodreads-author:5760737",
      },
    });
    const wrongAuthor = book({
      title: "The Traitor Baru Cormorant",
      foreignBookId: "wrong-author",
      author: { authorName: "Someone Else", foreignAuthorId: "999" },
    });
    const wrongTitle = book({
      title: "The Monster Baru Cormorant",
      foreignBookId: "wrong-title",
      author: { authorName: "Seth Dickinson", foreignAuthorId: "5760737" },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/search") {
        return url.searchParams.get("term") === "author:5760737"
          ? jsonResponse([])
          : jsonResponse([
            { book: wrongAuthor },
            { book: wrongTitle },
            { book: expected },
          ]);
      }
      if (url.pathname === "/api/v1/book/lookup") return jsonResponse([]);
      if (url.pathname === "/api/v1/book") return jsonResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const response = await createReadarrService().searchBooksByAuthorWithDiagnostics({
      authorForeignId: "5760737",
      targetTitle: "The Traitor Baru Cormorant",
      fallbackQuery: "The Traitor",
    });

    expect(response.books).toEqual([expected]);
    expect(response.warnings).toEqual([]);
  });

  it("accepts a clean empty exact-query response as the final result", async () => {
    const searchTerms: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/search") {
        const term = url.searchParams.get("term") ?? "";
        searchTerms.push(term);
        return term === "author:5760737"
          ? new Response(JSON.stringify({ message: "BookInfo failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
          : jsonResponse([]);
      }
      if (url.pathname === "/api/v1/book") return jsonResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const response = await createReadarrService().searchBooksByAuthorWithDiagnostics({
      authorForeignId: "5760737",
      targetTitle: "The Traitor Baru Cormorant",
      fallbackQuery: "The Traitor Baru Cormorant",
    });

    expect(response.books).toEqual([]);
    expect(response.warnings.join(" ")).toContain("original query");
    expect(response.warnings.join(" ")).toContain("including from its standard search");
    expect(searchTerms).toEqual([
      "author:5760737",
      "The Traitor Baru Cormorant",
    ]);
  });

  it("surfaces the exact-query error when both remote searches fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/search") {
        const fallback = url.searchParams.get("term") === "The Traitor";
        return new Response(JSON.stringify({
          message: fallback ? "Too many requests" : "BookInfo failed",
        }), {
          status: fallback ? 429 : 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/api/v1/book") return jsonResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await expect(
      createReadarrService().searchBooksByAuthorWithDiagnostics({
        authorForeignId: "5760737",
        targetTitle: "The Traitor Baru Cormorant",
        fallbackQuery: "The Traitor",
      }),
    ).rejects.toThrow("catalogue is busy");
  });

  it("keeps the existing author book-lookup fallback before using the original query", async () => {
    const expected = book({
      title: "The Traitor Baru Cormorant",
      foreignBookId: "43007917",
      author: { authorName: "Seth Dickinson", foreignAuthorId: "5760737" },
    });
    const searchTerms: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/search") {
        searchTerms.push(url.searchParams.get("term") ?? "");
        return jsonResponse([]);
      }
      if (url.pathname === "/api/v1/book/lookup") {
        expect(url.searchParams.get("term")).toBe("author:5760737");
        return jsonResponse([expected]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const response = await createReadarrService().searchBooksByAuthorWithDiagnostics({
      authorForeignId: "5760737",
      targetTitle: "The Traitor Baru Cormorant",
      fallbackQuery: "The Traitor",
    });

    expect(response.books).toEqual([expected]);
    expect(searchTerms).toEqual(["author:5760737"]);
    expect(response.warnings.join(" ")).not.toContain("original query");
  });

  it("returns a verified local match when both remote resolved searches fail", async () => {
    const localMatch = book({
      id: 91,
      title: "The Traitor Baru Cormorant",
      foreignBookId: "43007917",
      author: { authorName: "Seth Dickinson", foreignAuthorId: "5760737" },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/search") {
        return new Response(JSON.stringify({ message: "BookInfo failed" }), {
          status: url.searchParams.get("term") === "The Traitor" ? 429 : 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/api/v1/book") return jsonResponse([localMatch]);
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const response = await createReadarrService().searchBooksByAuthorWithDiagnostics({
      authorForeignId: "5760737",
      targetTitle: "The Traitor Baru Cormorant",
      fallbackQuery: "The Traitor",
    });

    expect(response.books).toEqual([localMatch]);
    expect(response.source).toBe("library");
    expect(response.warnings.join(" ")).not.toContain("original query");
    expect(response.warnings.join(" ")).toContain("Readarr library");
  });

  it("gives the exact-query fallback a fresh timeout after the author search expires", async () => {
    vi.useFakeTimers();
    const expected = book({
      title: "The Traitor Baru Cormorant",
      foreignBookId: "43007917",
      author: { authorName: "Seth Dickinson", foreignAuthorId: "5760737" },
    });
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === "/api/v1/search") {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        if (url.searchParams.get("term") === "author:5760737") {
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        return Promise.resolve(jsonResponse([{ book: expected }]));
      }
      if (url.pathname === "/api/v1/book") return Promise.resolve(jsonResponse([]));
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }));

    const pending = createReadarrService().searchBooksByAuthorWithDiagnostics({
      authorForeignId: "5760737",
      targetTitle: "The Traitor Baru Cormorant",
      fallbackQuery: "The Traitor",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;

    expect(response.books).toEqual([expected]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("confirms the returned author foreign ID before exposing a title match", async () => {
    const expected = book({
      title: "Prince of Thorns",
      foreignBookId: "9579634",
      author: { authorName: "Mark Lawrence", foreignAuthorId: "4721536" },
    });
    const wrongAuthor = book({
      title: "Prince of Thorns",
      foreignBookId: "wrong-work",
      author: { authorName: "Another Author", foreignAuthorId: "123" },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith("search")) {
        return jsonResponse([{ book: wrongAuthor }, { book: expected }]);
      }
      if (url.pathname.endsWith("book")) return jsonResponse([]);
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const response = await createReadarrService().searchBooksByAuthorWithDiagnostics({
      authorForeignId: "4721536",
      targetTitle: "Prince of Thorns",
    });

    expect(response.books).toEqual([expected]);
    expect(response.source).toBe("metadata");
    expect(response.warnings).toEqual([]);
  });

  it("repairs a known provider title artifact while retaining the author ID check", async () => {
    const malformedTitle =
      "TheName of theWind (Kingkiller Chronicles, Day 1)2nd (second) edition Text Only";
    const expected = book({
      title: malformedTitle,
      foreignBookId: "186074",
      author: { authorName: "Patrick Rothfuss", foreignAuthorId: "108424" },
    });
    const wrongAuthor = book({
      title: malformedTitle,
      foreignBookId: "wrong-work",
      author: { authorName: "Another Author", foreignAuthorId: "999" },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/api/v1/search");
      expect(url.searchParams.get("term")).toBe("author:108424");
      return jsonResponse([{ book: wrongAuthor }, { book: expected }]);
    }));

    const response = await createReadarrService().searchBooksByAuthorWithDiagnostics({
      authorForeignId: "108424",
      targetTitle: "The Name of the Wind",
    });

    expect(response.books).toEqual([expected]);
    expect(response.warnings).toEqual([]);
  });

  it("preserves diagnostics when an author lookup falls back to the local library", async () => {
    const localMatch = book({
      id: 91,
      title: "Prince of Thorns (The Broken Empire, #1)",
      foreignBookId: "9579634",
      author: { authorName: "Mark Lawrence", foreignAuthorId: "4721536" },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith("search") || url.pathname.endsWith("book/lookup")) {
        return new Response(JSON.stringify({ message: "Goodreads failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.endsWith("book")) return jsonResponse([localMatch]);
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const response = await createReadarrService().searchBooksByAuthorWithDiagnostics({
      authorForeignId: "4721536",
      targetTitle: "Prince of Thorns",
    });

    expect(response.books).toEqual([localMatch]);
    expect(response.source).toBe("library");
    expect(response.warnings.join(" ")).toContain("Readarr library");
  });

  it("rejects an invalid Goodreads author ID without querying Readarr", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createReadarrService().searchBooksByAuthor({
      authorForeignId: "not-an-id",
      targetTitle: "Prince of Thorns",
    })).rejects.toThrow("valid Goodreads ID");
    expect(fetchMock).not.toHaveBeenCalled();
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

      if (url.endsWith("/api/v1/author/51")) return jsonResponse(selection.author);

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
        return jsonResponse(authorBooksLookups >= 5 ? [createdBook] : []);
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
    expect(authorBooksLookups).toBe(5);
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

      if (url.endsWith("/api/v1/author/51")) return jsonResponse(selection.author);

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

  it("does not reuse a different book when a local Readarr ID has changed", async () => {
    const selection = book({ id: 101, author: { ...book().author, id: 51 } });
    let posted = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname.endsWith("author/51")) return jsonResponse(selection.author);
      if (url.pathname.endsWith("rootfolder")) return jsonResponse([{ path: "/books", defaultQualityProfileId: 1, defaultMetadataProfileId: 2 }]);
      if (url.pathname.endsWith("qualityprofile")) return jsonResponse([{ id: 1 }]);
      if (url.pathname.endsWith("metadataprofile")) return jsonResponse([{ id: 2 }]);
      if (url.pathname.endsWith("book/101")) return jsonResponse(book({ id: 101, title: "Wrong book", foreignBookId: "wrong" }));
      if (init?.method === "POST") { posted = true; return jsonResponse({ ...selection, id: 102 }); }
      return jsonResponse([]);
    }));
    expect((await createReadarrService().addBookForRequest(selection)).id).toBe(102);
    expect(posted).toBe(true);
  });

  it("takes profiles from the configured root folder, not the first root", async () => {
    vi.stubEnv("READARR_ROOT_FOLDER_PATH", "/chosen");
    resetAppConfigCache();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname.endsWith("rootfolder")) return jsonResponse([
        { path: "/first", defaultQualityProfileId: 1, defaultMetadataProfileId: 2 },
        { path: "/chosen", defaultQualityProfileId: 3, defaultMetadataProfileId: 4 },
      ]);
      if (url.pathname.endsWith("qualityprofile")) return jsonResponse([{ id: 1 }, { id: 3 }]);
      return jsonResponse([{ id: 2 }, { id: 4 }]);
    }));
    expect(await createReadarrService().resolveDefaults()).toEqual({ rootFolderPath: "/chosen", qualityProfileId: 3, metadataProfileId: 4 });
  });

  it("verifies stale local author IDs and finds the correct author by foreign identity", async () => {
    const selection = book({ author: { ...book().author, id: 51 } });
    const correctAuthor = { ...selection.author, id: 52 };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(init?.method).not.toBe("POST");
      if (new URL(input).pathname.endsWith("author/51")) {
        return jsonResponse({ id: 51, authorName: "A Different Author", foreignAuthorId: "999" });
      }
      return jsonResponse([correctAuthor]);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await createReadarrService().ensureAuthorExistsForBook(selection)).toEqual(correctAuthor);
  });

  it("does not duplicate an author when lookup metadata has no local ID", async () => {
    const existing = { ...book().author, id: 52 };
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.method).not.toBe("POST");
      return jsonResponse([existing]);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await createReadarrService().ensureAuthorExistsForBook(book())).toEqual(existing);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers an author created before a metadata-refresh error using only the local library", async () => {
    const existing = { ...book().author, id: 52 };
    let authorLists = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      expect(url.pathname).not.toContain("lookup");
      if (url.pathname.endsWith("rootfolder")) return jsonResponse([{ path: "/books", defaultQualityProfileId: 1, defaultMetadataProfileId: 2 }]);
      if (url.pathname.endsWith("qualityprofile")) return jsonResponse([{ id: 1 }]);
      if (url.pathname.endsWith("metadataprofile")) return jsonResponse([{ id: 2 }]);
      if (init?.method === "POST") return new Response(null, { status: 500 });
      return jsonResponse(++authorLists === 1 ? [] : [existing]);
    }));
    expect(await createReadarrService().ensureAuthorExistsForBook(book())).toEqual(existing);
  });

  it("clears stale instance IDs and paths before adding an author", async () => {
    const selection = book({ author: { ...book().author, id: 51, path: "/old-instance/author" } });
    let postedBody: unknown;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname.endsWith("author/51")) return new Response(null, { status: 404 });
      if (url.pathname.endsWith("rootfolder")) return jsonResponse([{ path: "/books", defaultQualityProfileId: 1, defaultMetadataProfileId: 2 }]);
      if (url.pathname.endsWith("qualityprofile")) return jsonResponse([{ id: 1 }]);
      if (url.pathname.endsWith("metadataprofile")) return jsonResponse([{ id: 2 }]);
      if (init?.method === "POST") {
        postedBody = JSON.parse(String(init.body));
        return jsonResponse({ ...book().author, id: 52 });
      }
      return jsonResponse([]);
    }));
    await createReadarrService().ensureAuthorExistsForBook(selection);
    expect(postedBody).toMatchObject({ id: 0, foreignAuthorId: "9", rootFolderPath: "/books", qualityProfileId: 1, metadataProfileId: 2 });
    expect(postedBody).not.toHaveProperty("path");
  });
});
