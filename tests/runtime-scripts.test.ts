import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kindling-runtime-"));
  directories.push(directory);
  return directory;
}

function runScript(script: string, databasePath: string, args: string[] = []) {
  return execute(process.execPath, ["--import", "tsx", script, ...args], {
    env: { ...process.env, DATABASE_PATH: databasePath },
    timeout: 10_000,
  });
}

describe("runtime maintenance commands", () => {
  it("initializes profiles once and preserves household changes on later startup", async () => {
    const directory = await temporaryDirectory();
    const databasePath = path.join(directory, "kindling.db");
    await runScript("scripts/init.ts", databasePath);
    const database = new Database(databasePath);
    try {
      expect(database.prepare("SELECT name FROM users").all()).toHaveLength(3);
      database.prepare("UPDATE users SET name = ? WHERE name = ?").run("Alex", "Adam");
      await runScript("scripts/init.ts", databasePath);
      expect(database.prepare("SELECT name FROM users ORDER BY name").all()).toEqual([
        { name: "Alex" }, { name: "Dad" }, { name: "Mum" },
      ]);
    } finally {
      database.close();
    }
  });

  it("backs up committed WAL data while the database is open and refuses overwrites", async () => {
    const directory = await temporaryDirectory();
    const databasePath = path.join(directory, "kindling.db");
    const backupPath = path.join(directory, "backups", "snapshot.db");
    const database = new Database(databasePath);
    try {
      database.pragma("journal_mode = WAL");
      database.exec("CREATE TABLE saved_requests (title TEXT NOT NULL)");
      database.prepare("INSERT INTO saved_requests VALUES (?)").run("A saved household book");
      await runScript("scripts/backup.ts", databasePath, [backupPath]);
      const snapshot = new Database(backupPath, { readonly: true });
      try {
        expect(snapshot.prepare("SELECT title FROM saved_requests").all()).toEqual([
          { title: "A saved household book" },
        ]);
        // Backup must not add application tables or apply new migrations to the live DB.
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
          .toEqual([{ name: "saved_requests" }]);
      } finally {
        snapshot.close();
      }
      const previous = await fs.readFile(backupPath);
      await expect(runScript("scripts/backup.ts", databasePath, [backupPath])).rejects.toThrow();
      expect(await fs.readFile(backupPath)).toEqual(previous);
      await expect(runScript("scripts/backup.ts", databasePath, [databasePath])).rejects.toThrow();
      expect(database.prepare("SELECT title FROM saved_requests").get()).toBeTruthy();
    } finally {
      database.close();
    }
  });

  it("does not create a database or misleading backup for an incorrect source path", async () => {
    const directory = await temporaryDirectory();
    const databasePath = path.join(directory, "missing.db");
    const backupPath = path.join(directory, "snapshot.db");
    await expect(runScript("scripts/backup.ts", databasePath, [backupPath])).rejects.toThrow();
    await expect(fs.stat(databasePath)).rejects.toThrow();
    await expect(fs.stat(backupPath)).rejects.toThrow();
  });
});
