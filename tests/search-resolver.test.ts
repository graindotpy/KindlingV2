import { describe, expect, it, vi } from "vitest";
import type {
  OpenLibraryAuthorCandidate,
  OpenLibraryBookCandidate,
  OpenLibraryRequestOptions,
} from "@/lib/openlibrary/types";
import { SearchResolutionError, createSearchResolver } from "@/lib/search/resolver";

const markLawrence = { key: "OL6983136A", name: "Mark Lawrence" };
const princeOfThorns = {
  key: "OL17450797W",
  title: "Prince of Thorns",
  authors: [markLawrence],
  firstPublishYear: 2011,
  coverUrl: "https://covers.openlibrary.org/b/id/7603832-M.jpg",
};

function makeOpenLibrary() {
  return {
    searchBookCandidates: vi.fn<(
      query: string,
      options?: OpenLibraryRequestOptions,
    ) => Promise<OpenLibraryBookCandidate[]>>(async () => []),
    searchIsbnCandidates: vi.fn<(
      isbn: string,
      options?: OpenLibraryRequestOptions,
    ) => Promise<OpenLibraryBookCandidate[]>>(async () => []),
    searchAuthorCandidates: vi.fn<(
      query: string,
      options?: OpenLibraryRequestOptions,
    ) => Promise<OpenLibraryAuthorCandidate[]>>(async () => []),
    getGoodreadsAuthorId: vi.fn<(
      authorKey: string,
      options?: OpenLibraryRequestOptions,
    ) => Promise<string | null>>(async () => null),
  };
}

describe("search resolver", () => {
  it("preserves explicit Goodreads and Readarr identifier searches", async () => {
    const openLibrary = makeOpenLibrary();
    const resolver = createSearchResolver(openLibrary as never);

    await expect(resolver.resolve("author:4721536")).resolves.toMatchObject({
      state: "search",
      readarrQuery: "author:4721536",
      bookMatch: null,
    });
    expect(openLibrary.searchBookCandidates).not.toHaveBeenCalled();
  });

  it("automatically resolves one exact title through its Open Library author key", async () => {
    const openLibrary = makeOpenLibrary();
    openLibrary.searchBookCandidates.mockResolvedValueOnce([princeOfThorns]);
    openLibrary.getGoodreadsAuthorId.mockResolvedValueOnce("4721536");

    await expect(
      createSearchResolver(openLibrary as never).resolve("Prince of Thorns"),
    ).resolves.toEqual({
      state: "search",
      readarrQuery: "author:4721536",
      bookMatch: {
        authorForeignId: "4721536",
        targetTitle: "Prince of Thorns",
        alternateTitles: ["Prince of Thorns"],
        fallbackQuery: "Prince of Thorns",
      },
      warnings: [],
    });
    expect(openLibrary.getGoodreadsAuthorId).toHaveBeenCalledWith(
      "OL6983136A",
      { signal: undefined },
    );
  });

  it("returns distinct exact-title choices before looking up a Goodreads author ID", async () => {
    const openLibrary = makeOpenLibrary();
    openLibrary.searchBookCandidates.mockResolvedValueOnce([
      princeOfThorns,
      {
        ...princeOfThorns,
        key: "OL25857958W",
        authors: [{ key: "OL9778743A", name: "Alexis Fegan Black" }],
        firstPublishYear: 2015,
      },
    ]);

    const resolution = await createSearchResolver(openLibrary as never).resolve("Prince of Thorns");

    expect(resolution).toMatchObject({
      state: "choose",
      candidates: [
        { key: "OL17450797W", author: "Mark Lawrence", year: 2011 },
        { key: "OL25857958W", author: "Alexis Fegan Black", year: 2015 },
      ],
    });
    expect(openLibrary.getGoodreadsAuthorId).not.toHaveBeenCalled();
  });

  it("preserves the user's original title for the final Readarr fallback", async () => {
    const openLibrary = makeOpenLibrary();
    openLibrary.searchBookCandidates.mockResolvedValueOnce([princeOfThorns]);
    openLibrary.getGoodreadsAuthorId.mockResolvedValueOnce("4721536");

    const resolution = await createSearchResolver(openLibrary as never).resolve(
      "Prince",
      "OL17450797W",
    );

    expect(resolution).toMatchObject({
      state: "search",
      readarrQuery: "author:4721536",
      bookMatch: {
        targetTitle: "Prince of Thorns",
        fallbackQuery: "Prince",
      },
    });
  });

  it("revalidates a selected work against the original query", async () => {
    const openLibrary = makeOpenLibrary();
    openLibrary.searchBookCandidates.mockResolvedValue([princeOfThorns]);
    const resolver = createSearchResolver(openLibrary as never);

    await expect(
      resolver.resolve("Prince of Thorns", "OL999999W"),
    ).rejects.toBeInstanceOf(SearchResolutionError);
    expect(openLibrary.getGoodreadsAuthorId).not.toHaveBeenCalled();
  });

  it("tries another credited author when the primary author has no Goodreads ID", async () => {
    const openLibrary = makeOpenLibrary();
    openLibrary.searchBookCandidates.mockResolvedValueOnce([{
      ...princeOfThorns,
      authors: [markLawrence, { key: "OL2A", name: "Second Author" }],
    }]);
    openLibrary.getGoodreadsAuthorId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("222");

    const resolution = await createSearchResolver(openLibrary as never).resolve("Prince of Thorns");

    expect(resolution).toMatchObject({
      state: "search",
      readarrQuery: "author:222",
      bookMatch: { authorForeignId: "222" },
    });
  });

  it("uses ISBN resolution before Readarr's standard ISBN lookup", async () => {
    const openLibrary = makeOpenLibrary();
    openLibrary.searchIsbnCandidates.mockResolvedValueOnce([princeOfThorns]);
    openLibrary.getGoodreadsAuthorId.mockResolvedValueOnce("4721536");

    const resolution = await createSearchResolver(openLibrary as never).resolve("978-0-00-000000-2");

    expect(openLibrary.searchIsbnCandidates).toHaveBeenCalledWith(
      "9780000000002",
      { signal: undefined },
    );
    expect(resolution).toMatchObject({ readarrQuery: "author:4721536" });
  });

  it("resolves an exact author name when no book-title candidates exist", async () => {
    const openLibrary = makeOpenLibrary();
    openLibrary.searchAuthorCandidates.mockResolvedValueOnce([{
      key: "OL6983136A",
      name: "Mark Lawrence",
      topWork: "Red Sister",
      workCount: 36,
    }]);
    openLibrary.getGoodreadsAuthorId.mockResolvedValueOnce("4721536");

    await expect(
      createSearchResolver(openLibrary as never).resolve("Mark Lawrence"),
    ).resolves.toMatchObject({
      state: "search",
      readarrQuery: "author:4721536",
      bookMatch: null,
    });
  });

  it("prefers an exact author name over unrelated approximate title suggestions", async () => {
    const openLibrary = makeOpenLibrary();
    openLibrary.searchBookCandidates.mockResolvedValueOnce([{
      ...princeOfThorns,
      title: "DHL - D.H. Lawrence by Mark Schorer",
    }]);
    openLibrary.searchAuthorCandidates.mockResolvedValueOnce([{
      key: "OL6983136A",
      name: "Mark Lawrence",
      topWork: "Red Sister",
      workCount: 36,
    }]);
    openLibrary.getGoodreadsAuthorId.mockResolvedValueOnce("4721536");

    await expect(
      createSearchResolver(openLibrary as never).resolve("Mark Lawrence"),
    ).resolves.toMatchObject({
      state: "search",
      readarrQuery: "author:4721536",
      bookMatch: null,
    });
  });

  it("falls back to the existing search with a warning when Open Library is unavailable", async () => {
    const openLibrary = makeOpenLibrary();
    openLibrary.searchBookCandidates.mockRejectedValueOnce(new Error("upstream details"));

    const resolution = await createSearchResolver(openLibrary as never).resolve("Prince of Thorns");

    expect(resolution).toMatchObject({
      state: "search",
      readarrQuery: "Prince of Thorns",
      bookMatch: null,
      warnings: [expect.stringContaining("standard search")],
    });
    expect(JSON.stringify(resolution)).not.toContain("upstream details");
  });
});
