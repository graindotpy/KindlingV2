import type Database from "better-sqlite3";
import { getDb } from "@/lib/db/client";

type SettingRow = {
  key: string;
  value: string | null;
  updated_at: string;
};

export function createSettingsRepository(database: Database.Database = getDb()) {
  const listStatement = database.prepare(
    "SELECT key, value, updated_at FROM app_settings ORDER BY key ASC",
  );
  const getStatement = database.prepare(
    "SELECT key, value, updated_at FROM app_settings WHERE key = ?",
  );
  const upsertStatement = database.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  return {
    list() {
      return listStatement.all() as SettingRow[];
    },

    get(key: string) {
      return (getStatement.get(key) as SettingRow | undefined) ?? null;
    },

    set(key: string, value: string | null, updatedAt: string) {
      upsertStatement.run(key, value, updatedAt);
      return this.get(key);
    },
  };
}
