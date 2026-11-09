import { getDefaultResultOrder, setDefaultResultOrder } from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppConfigCache } from "@/lib/config";
import {
  createOpenLibraryService,
  OpenLibraryApiError,
  resetOpenLibraryCache,
} from "@/lib/openlibrary/service";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

function bookPayload() {
  return {
    docs: [{
      key: "/works/OL17450797W",
      title: "Prince of Thorns",
      author_key: ["OL6983136A", "OL123A"],
      author_name: ["Mark Lawrence", "Second Author"],
      first_publish_year: 2011,
      cover_i: 7603832,
    }],
  };
}

const originalDnsOrder = getDefaultResultOrder();

describe("Open Library service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("OPENLIBRARY_CONTACT_EMAIL", "contact@example.com");
    resetAppConfigCache();
    resetOpenLibraryCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    setDefaultResultOrder(originalDnsOrder);
    vi.unstubAllEnvs();
    resetAppConfigCache();
    resetOpenLibraryCache();
  });

  it("searches titles with selected fields and returns normalized candidate DTOs", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      expect(url.origin).toBe("https://openlibrary.org");
      expect(url.pathname).toBe("/search.json");
      expect(url.searchParams.get("title")).toBe("Prince of Thorns");
      expect(url.searchParams.get("limit")).toBe("8");
      expect(url.searchParams.get("fields")).toBe(
        "key,title,author_key,author_name,first_publish_year,cover_i",
      );
      expect(new Headers(init?.headers).get("User-Agent")).toBe(
        "Kindling/0.1 (contact@example.com)",
      );
      expect(init?.cache).toBe("no-store");
      return jsonResponse(bookPayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    const candidates = await createOpenLibraryService().searchBookCandidates(
      "  Prince   of Thorns  ",
    );

    expect(candidates).toEqual([{
      key: "OL17450797W",
      title: "Prince of Thorns",
      authors: [
        { key: "OL6983136A", name: "Mark Lawrence" },
        { key: "OL123A", name: "Second Author" },
      ],
      firstPublishYear: 2011,
      coverUrl: "https://covers.openlibrary.org/b/id/7603832-M.jpg",
    }]);
    expect(JSON.stringify(candidates)).not.toContain("contact@example.com");
  });

  it("runs keyword searches with q= instead of the title field", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/search.json");
      expect(url.searchParams.get("q")).toBe("The Bonehunters");
      expect(url.searchParams.has("title")).toBe(false);
      return jsonResponse(bookPayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    const candidates = await createOpenLibraryService().searchBookCandidatesByKeywords(" The  Bonehunters ");
    expect(candidates.map((candidate) => candidate.key)).toEqual(["OL17450797W"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps valid books when Open Library mixes in a malformed unrelated work", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payload = bookPayload();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      docs: [
        ...payload.docs,
        {
          key: "/works/OL19256841M",
          title: "An unrelated malformed catalogue record",
          first_publish_year: 1855,
        },
      ],
    })));

    await expect(createOpenLibraryService().searchBookCandidates("The Name of the Wind"))
      .resolves.toEqual([expect.objectContaining({
        key: "OL17450797W",
        title: "Prince of Thorns",
      })]);
    expect(warning).toHaveBeenCalledWith(
      "[kindling] Open Library book-search ignored 1 malformed result(s).",
    );
  });

  it("normalizes ISBN searches and rejects invalid identifiers before fetching", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      expect(url.searchParams.get("isbn")).toBe("9780152047375");
      expect(url.searchParams.has("title")).toBe(false);
      return jsonResponse(bookPayload());
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = createOpenLibraryService();

    await expect(service.searchIsbnCandidates("ISBN: 978-0-15-204737-5"))
      .resolves.toHaveLength(1);
    await expect(service.searchIsbnCandidates("not-an-isbn"))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports author-name discovery for author-only searches", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/search/authors.json");
      expect(url.searchParams.get("q")).toBe("Mark Lawrence");
      expect(url.searchParams.get("limit")).toBe("8");
      return jsonResponse({
        docs: [
          { key: "OL6983136A", name: "Mark Lawrence", top_work: "Red Sister", work_count: 36 },
          { key: "/authors/OL2877997A", name: "Mark Lawrence" },
        ],
      });
    }));

    await expect(createOpenLibraryService().searchAuthorCandidates("Mark Lawrence"))
      .resolves.toEqual([
        { key: "OL6983136A", name: "Mark Lawrence", topWork: "Red Sister", workCount: 36 },
        { key: "OL2877997A", name: "Mark Lawrence", topWork: null, workCount: null },
      ]);
  });

  it("extracts Goodreads IDs from author details and preserves a missing mapping as null", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/authors/OL6983136A.json") {
        return jsonResponse({
          key: "/authors/OL6983136A",
          remote_ids: { goodreads: "4721536", wikidata: "Q641046" },
        });
      }
      return jsonResponse({ key: "/authors/OL123A", remote_ids: { wikidata: "Q1" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = createOpenLibraryService();

    await expect(service.getGoodreadsAuthorId("/authors/ol6983136a"))
      .resolves.toBe("4721536");
    await expect(service.getGoodreadsAuthorId("OL123A")).resolves.toBeNull();
    await expect(service.getGoodreadsAuthorId("../../private"))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces in-flight and fresh cached searches", async () => {
    let release: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async () => new Promise<Response>((resolve) => {
      release = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const service = createOpenLibraryService();

    const first = service.searchBookCandidates("Prince of Thorns");
    const second = service.searchBookCandidates(" prince   OF thorns ");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release?.(jsonResponse(bookPayload()));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.any(Array),
      expect.any(Array),
    ]);
    await service.searchBookCandidates("Prince of Thorns");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("paces anonymous upstream requests at one per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubEnv("OPENLIBRARY_CONTACT_EMAIL", "");
    resetAppConfigCache();
    resetOpenLibraryCache();
    const fetchMock = vi.fn(async () => jsonResponse(bookPayload()));
    vi.stubGlobal("fetch", fetchMock);
    const service = createOpenLibraryService();

    const first = service.searchBookCandidates("Prince of Thorns");
    await vi.advanceTimersByTimeAsync(0);
    await first;
    const second = service.searchBookCandidates("Red Sister");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("prefers IPv4 and retries one transient connection reset without leaking details", async () => {
    setDefaultResultOrder("verbatim");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(
        new TypeError("The Name of the Wind contact@example.com secret"),
        { cause: { code: "ECONNRESET" } },
      ))
      .mockResolvedValueOnce(jsonResponse(bookPayload()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createOpenLibraryService().searchBookCandidates("The Name of the Wind"))
      .resolves.toHaveLength(1);

    expect(getDefaultResultOrder()).toBe("ipv4first");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const logs = warning.mock.calls.flat().join(" ");
    expect(logs).toContain("attempt 1/2 failed; retrying");
    expect(logs).toContain("econnreset");
    expect(logs).not.toMatch(/The Name of the Wind|contact@example\.com|secret/i);
  });

  it.each([429, 500, 503])(
    "retries temporary HTTP %i responses once",
    async (status) => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response("temporary", { status }))
        .mockResolvedValueOnce(jsonResponse(bookPayload()));
      vi.stubGlobal("fetch", fetchMock);

      const pending = createOpenLibraryService().searchBookCandidates("Prince of Thorns");
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("does not retry permanent HTTP errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createOpenLibraryService().searchBookCandidates("Missing Book"))
      .rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("expires cached values after a bounded TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fetchMock = vi.fn(async () => jsonResponse(bookPayload()));
    vi.stubGlobal("fetch", fetchMock);
    const service = createOpenLibraryService();

    await service.searchBookCandidates("Prince of Thorns");
    await service.searchBookCandidates("Prince of Thorns");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T00:10:00.001Z"));
    await service.searchBookCandidates("Prince of Thorns");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the cache size bounded", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(bookPayload()));
    vi.stubGlobal("fetch", fetchMock);
    const service = createOpenLibraryService();

    for (let index = 0; index < 65; index += 1) {
      await service.searchBookCandidates(`Book ${index}`);
    }
    await service.searchBookCandidates("Book 0");
    expect(fetchMock).toHaveBeenCalledTimes(66);
  });

  it("bounds unresponsive calls and returns a sanitized timeout", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("contact@example.com secret stack", "AbortError")),
          { once: true },
        );
      }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = createOpenLibraryService().searchBookCandidates("Prince of Thorns");
    const assertion = expect(pending).rejects.toMatchObject({
      message: "Open Library took too long to respond. Please try again shortly.",
      status: 504,
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const logs = warning.mock.calls.flat().join(" ");
    expect(logs).toContain("timeout");
    expect(logs).not.toMatch(/contact@example\.com|secret stack/i);

    fetchMock.mockImplementationOnce(async () => jsonResponse(bookPayload()));
    await expect(createOpenLibraryService().searchBookCandidates("Prince of Thorns"))
      .resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not expose upstream bodies or the configured contact in errors", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response(
      "<html>contact@example.com upstream stack and credentials</html>",
      { status: 500 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const pending = createOpenLibraryService().searchBookCandidates("Prince of Thorns")
      .catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error).toBeInstanceOf(OpenLibraryApiError);
    expect((error as Error).message).toBe(
      "Open Library could not provide book metadata. Please try again shortly.",
    );
    expect((error as Error).message).not.toMatch(/contact@example\.com|stack|credentials/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls.flat().join(" "))
      .not.toMatch(/contact@example\.com|stack|credentials|Prince of Thorns/i);
  });

  it("rejects malformed successful payloads and mismatched author records", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      return url.pathname === "/search.json"
        ? jsonResponse({ docs: [{ key: "bad-key", title: "Unsafe" }] })
        : jsonResponse({ key: "/authors/OL999A", remote_ids: { goodreads: "4721536" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = createOpenLibraryService();

    await expect(service.searchBookCandidates("Unsafe"))
      .rejects.toThrow("unexpected book response");
    await expect(service.getGoodreadsAuthorId("OL6983136A"))
      .rejects.toThrow("unexpected author response");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
