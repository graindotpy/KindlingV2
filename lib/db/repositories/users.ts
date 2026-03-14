import type Database from "better-sqlite3";
import { getDb } from "@/lib/db/client";
import type { LocalUser } from "@/lib/requests/types";

type UserRow = {
  id: number;
  name: string;
  kindle_email: string | null;
  created_at: string;
  request_count: number;
};

function mapUser(row: UserRow): LocalUser {
  return {
    id: row.id,
    name: row.name,
    kindleEmail: row.kindle_email,
    createdAt: row.created_at,
    requestCount: row.request_count ?? 0,
  };
}

export function createUsersRepository(database: Database.Database = getDb()) {
  const selectBase = `
    SELECT
      users.id,
      users.name,
      users.kindle_email,
      users.created_at,
      (
        SELECT COUNT(*)
        FROM book_requests
        WHERE book_requests.user_id = users.id
      ) AS request_count
    FROM users
  `;
  const listStatement = database.prepare(
    `${selectBase} ORDER BY users.name COLLATE NOCASE ASC`,
  );
  const getByIdStatement = database.prepare(`${selectBase} WHERE users.id = ?`);
  const getByNameStatement = database.prepare(
    `${selectBase} WHERE users.name = ? COLLATE NOCASE LIMIT 1`,
  );
  const countStatement = database.prepare("SELECT COUNT(*) AS count FROM users");
  const insertStatement = database.prepare(
    "INSERT INTO users (name, kindle_email, created_at) VALUES (?, ?, ?)",
  );
  const updateStatement = database.prepare(`
    UPDATE users
    SET name = ?, kindle_email = ?
    WHERE id = ?
  `);
  const deleteStatement = database.prepare("DELETE FROM users WHERE id = ?");

  return {
    list(): LocalUser[] {
      return listStatement.all().map((row) => mapUser(row as UserRow));
    },

    getById(id: number): LocalUser | null {
      const row = getByIdStatement.get(id) as UserRow | undefined;
      return row ? mapUser(row) : null;
    },

    findByName(name: string): LocalUser | null {
      const row = getByNameStatement.get(name) as UserRow | undefined;
      return row ? mapUser(row) : null;
    },

    count() {
      const row = countStatement.get() as { count: number };
      return row.count;
    },

    ensureMany(entries: Array<{ name: string; kindleEmail: string | null }>) {
      const insertUsers = database.transaction(
        (profiles: Array<{ name: string; kindleEmail: string | null }>) => {
          if (this.count() > 0) {
            return;
          }

          const now = new Date().toISOString();

          for (const profile of profiles) {
            insertStatement.run(profile.name, profile.kindleEmail, now);
          }
        },
      );

      insertUsers(entries);
      return this.list();
    },

    update(id: number, input: { name: string; kindleEmail: string | null }) {
      updateStatement.run(input.name, input.kindleEmail, id);
      return this.getById(id);
    },

    create(input: { name: string; kindleEmail: string | null }) {
      const now = new Date().toISOString();
      const result = insertStatement.run(input.name, input.kindleEmail, now);
      return this.getById(Number(result.lastInsertRowid));
    },

    delete(id: number) {
      const result = deleteStatement.run(id);
      return result.changes > 0;
    },
  };
}
