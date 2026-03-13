import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getAppConfig } from "@/lib/config";

let database: Database.Database | null = null;

function applyMigrations(db: Database.Database) {
  const migrationsDir = path.join(process.cwd(), "lib", "db", "migrations");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((row) => {
      const record = row as { name: string };
      return record.name;
    }),
  );

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const file of migrationFiles) {
    if (applied.has(file)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const appliedAt = new Date().toISOString();

    const runMigration = db.transaction(() => {
      db.exec(sql);
      insertMigration.run(file, appliedAt);
    });

    runMigration();
  }
}

export function getDb() {
  if (database) {
    return database;
  }

  const config = getAppConfig();
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

  database = new Database(config.databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");

  applyMigrations(database);

  return database;
}

export function initializeDatabase() {
  return getDb();
}
