import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDb } from "@/lib/db/client";
import { resetAppConfigCache } from "@/lib/config";
import { createUsersRepository } from "@/lib/db/repositories/users";

const temporaryDirectories: string[] = [];
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  resetAppConfigCache();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SQLite startup", () => {
  it("migrates an empty database, preserves household edits across restarts, and enables foreign keys", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kindling-db-test-"));
    temporaryDirectories.push(directory);
    vi.stubEnv("DATABASE_PATH", path.join(directory, "kindling.db"));
    resetAppConfigCache();
    const db = getDb();
    const migrations = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all();
    expect(migrations).toHaveLength(4);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    const users = createUsersRepository(db);
    users.ensureMany([{ name: "Reader", kindleEmail: null }]);
    const reader = users.list()[0];
    users.update(reader.id, { name: "Alex", kindleEmail: "alex@kindle.com" });
    closeDatabase();
    const reopened = getDb();
    expect(reopened.prepare("SELECT name FROM schema_migrations ORDER BY name").all()).toEqual(migrations);
    const afterRestart = createUsersRepository(reopened);
    afterRestart.ensureMany([{ name: "Reader", kindleEmail: null }]);
    expect(afterRestart.list()).toEqual([expect.objectContaining({ name: "Alex", kindleEmail: "alex@kindle.com" })]);
  });
});
