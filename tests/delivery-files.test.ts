import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isKindleDeliverableFile, scanWatchDirectory } from "@/lib/delivery/files";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("Kindle deliverable files", () => {
  it("accepts only formats Send to Kindle still delivers", () => {
    expect(isKindleDeliverableFile("/books/The Borrowers.epub")).toBe(true);
    expect(isKindleDeliverableFile("/books/The Borrowers.PDF")).toBe(true);
    for (const name of ["book.mobi", "book.azw", "book.azw3", "book.m4b", "book"]) {
      expect(isKindleDeliverableFile(name)).toBe(false);
    }
  });

  it("skips MOBI and AZW files when scanning the watched folder", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kindling-files-"));
    await fs.mkdir(path.join(tempDir, "Mary Norton"));
    for (const name of ["The Borrowers.epub", "The Borrowers.mobi", "The Borrowers.azw3"]) {
      await fs.writeFile(path.join(tempDir, "Mary Norton", name), "");
    }

    const files = await scanWatchDirectory(tempDir);
    expect(files.map((file) => file.basename)).toEqual(["The Borrowers.epub"]);
  });
});
