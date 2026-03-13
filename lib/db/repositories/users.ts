import type Database from "better-sqlite3";
import { getDb } from "@/lib/db/client";
import type { LocalUser } from "@/lib/requests/types";

type UserRow = {
  id: number;
  name: string;
  created_at: string;
};

function mapUser(row: UserRow): LocalUser {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  };
}

export function createUsersRepository(database: Database.Database = getDb()) {
  const listStatement = database.prepare(
    "SELECT id, name, created_at FROM users ORDER BY name COLLATE NOCASE ASC",
  );
  const getByIdStatement = database.prepare(
    "SELECT id, name, created_at FROM users WHERE id = ?",
  );
  const insertStatement = database.prepare(
    "INSERT INTO users (name, created_at) VALUES (?, ?)",
  );

  return {
    list(): LocalUser[] {
      return listStatement.all().map((row) => mapUser(row as UserRow));
    },

    getById(id: number): LocalUser | null {
      const row = getByIdStatement.get(id) as UserRow | undefined;
      return row ? mapUser(row) : null;
    },

    ensureMany(names: string[]) {
      const insertUsers = database.transaction((entries: string[]) => {
        const now = new Date().toISOString();
        const existing = new Set(this.list().map((user) => user.name.toLowerCase()));

        for (const name of entries) {
          if (existing.has(name.toLowerCase())) {
            continue;
          }

          insertStatement.run(name, now);
          existing.add(name.toLowerCase());
        }
      });

      insertUsers(names);
      return this.list();
    },
  };
}
