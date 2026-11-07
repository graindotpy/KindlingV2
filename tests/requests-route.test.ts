import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), bootstrap: vi.fn(), ensureUsers: vi.fn(), createRequest: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireApiSession: mocks.auth }));
vi.mock("@/lib/bootstrap", () => ({ ensureBackgroundServices: mocks.bootstrap }));
vi.mock("@/lib/users/service", () => ({ ensureDefaultUsers: mocks.ensureUsers }));
vi.mock("@/lib/requests/service", () => ({
  createRequestService: () => ({ createRequest: mocks.createRequest }),
}));

import { POST } from "@/app/api/requests/route";
import {
  clearSearchSelections,
  findSearchSelection,
  rememberSearchSelections,
} from "@/lib/search/selection-cache";

const serverBook = {
  id: 0,
  title: "The Borrowers",
  foreignBookId: "42",
  author: { authorName: "Mary Norton", foreignAuthorId: "7" },
};

function searchResult(book: typeof serverBook | null, format: "ebook" | "audiobook" = "ebook") {
  return {
    fingerprint: "book:42",
    actions: {
      ebook: { source: format === "ebook" ? book : null },
      audiobook: { source: format === "audiobook" ? book : null },
    },
  };
}

function postRequest(body: unknown) {
  return POST(new NextRequest("http://localhost/api/requests", {
    method: "POST",
    body: JSON.stringify(body),
  }));
}

describe("request creation API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearSearchSelections();
    mocks.auth.mockReturnValue(null);
    mocks.createRequest.mockResolvedValue({ id: 1 });
  });

  it("uses Kindling's own search result instead of the browser's copy", async () => {
    rememberSearchSelections([searchResult(serverBook)]);

    const response = await postRequest({
      userId: 1,
      requestFormat: "ebook",
      selection: {
        foreignBookId: "42",
        title: "Tampered title",
        path: "/somewhere/else",
        author: { foreignAuthorId: "7", rootFolderPath: "/tmp" },
      },
    });

    expect(response.status).toBe(201);
    expect(mocks.createRequest).toHaveBeenCalledWith(1, "ebook", serverBook);
  });

  it("asks the person to search again when the result is unknown", async () => {
    const response = await postRequest({
      userId: 1,
      requestFormat: "ebook",
      selection: { foreignBookId: "42", author: { foreignAuthorId: "7" } },
    });

    expect(response.status).toBe(409);
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("keeps formats separate", async () => {
    rememberSearchSelections([searchResult(serverBook, "audiobook")]);

    const response = await postRequest({
      userId: 1,
      requestFormat: "ebook",
      selection: { foreignBookId: "42", author: { foreignAuthorId: "7" } },
    });

    expect(response.status).toBe(409);
  });

  it("does not match a different author for the same book id", async () => {
    rememberSearchSelections([searchResult(serverBook)]);

    const response = await postRequest({
      userId: 1,
      requestFormat: "ebook",
      selection: { foreignBookId: "42", author: { foreignAuthorId: "8" } },
    });

    expect(response.status).toBe(409);
  });
});

describe("search selection cache", () => {
  beforeEach(() => clearSearchSelections());

  it("expires remembered results", () => {
    rememberSearchSelections([searchResult(serverBook)], 0);
    expect(findSearchSelection("ebook", "42", "7", 1_000)).toEqual(serverBook);
    expect(findSearchSelection("ebook", "42", "7", 31 * 60_000)).toBeNull();
  });

  it("ignores results without a verified identity", () => {
    rememberSearchSelections([{ title: "No actions" }, searchResult(null)]);
    expect(findSearchSelection("ebook", "42", "7")).toBeNull();
  });
});
