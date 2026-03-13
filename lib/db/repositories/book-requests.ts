import type Database from "better-sqlite3";
import { getDb } from "@/lib/db/client";
import type { BookRequestRecord, BookRequestStatus } from "@/lib/requests/types";

type BookRequestRow = {
  id: number;
  user_id: number;
  user_name: string;
  request_fingerprint: string;
  requested_title: string;
  requested_author: string;
  requested_year: number | null;
  requested_at: string;
  status: BookRequestStatus;
  status_message: string | null;
  foreign_author_id: string | null;
  foreign_book_id: string | null;
  foreign_edition_id: string | null;
  readarr_author_id: number | null;
  readarr_book_id: number | null;
  readarr_edition_id: number | null;
  cover_url: string | null;
  notes: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateBookRequestInput = {
  userId: number;
  requestFingerprint: string;
  requestedTitle: string;
  requestedAuthor: string;
  requestedYear: number | null;
  requestedAt: string;
  status: BookRequestStatus;
  statusMessage: string | null;
  foreignAuthorId: string | null;
  foreignBookId: string | null;
  foreignEditionId: string | null;
  readarrAuthorId: number | null;
  readarrBookId: number | null;
  readarrEditionId: number | null;
  coverUrl: string | null;
  notes: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpdateBookRequestInput = Partial<
  Omit<BookRequestRecord, "id" | "userId" | "userName">
> & {
  updatedAt?: string;
};

function mapBookRequest(row: BookRequestRow): BookRequestRecord {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    requestFingerprint: row.request_fingerprint,
    requestedTitle: row.requested_title,
    requestedAuthor: row.requested_author,
    requestedYear: row.requested_year,
    requestedAt: row.requested_at,
    status: row.status,
    statusMessage: row.status_message,
    foreignAuthorId: row.foreign_author_id,
    foreignBookId: row.foreign_book_id,
    foreignEditionId: row.foreign_edition_id,
    readarrAuthorId: row.readarr_author_id,
    readarrBookId: row.readarr_book_id,
    readarrEditionId: row.readarr_edition_id,
    coverUrl: row.cover_url,
    notes: row.notes,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function makePlaceholders(length: number) {
  return Array.from({ length }, () => "?").join(", ");
}

export function createBookRequestsRepository(database: Database.Database = getDb()) {
  const selectBase = `
    SELECT
      book_requests.id,
      book_requests.user_id,
      users.name AS user_name,
      book_requests.request_fingerprint,
      book_requests.requested_title,
      book_requests.requested_author,
      book_requests.requested_year,
      book_requests.requested_at,
      book_requests.status,
      book_requests.status_message,
      book_requests.foreign_author_id,
      book_requests.foreign_book_id,
      book_requests.foreign_edition_id,
      book_requests.readarr_author_id,
      book_requests.readarr_book_id,
      book_requests.readarr_edition_id,
      book_requests.cover_url,
      book_requests.notes,
      book_requests.last_synced_at,
      book_requests.created_at,
      book_requests.updated_at
    FROM book_requests
    INNER JOIN users ON users.id = book_requests.user_id
  `;

  const listByUserStatement = database.prepare(
    `${selectBase} WHERE book_requests.user_id = ? ORDER BY book_requests.requested_at DESC, book_requests.id DESC`,
  );
  const listAllStatement = database.prepare(
    `${selectBase} ORDER BY book_requests.requested_at DESC, book_requests.id DESC`,
  );
  const getByIdStatement = database.prepare(`${selectBase} WHERE book_requests.id = ?`);
  const getByUserAndFingerprintStatement = database.prepare(
    `${selectBase} WHERE book_requests.user_id = ? AND book_requests.request_fingerprint = ?`,
  );
  const insertStatement = database.prepare(`
    INSERT INTO book_requests (
      user_id,
      request_fingerprint,
      requested_title,
      requested_author,
      requested_year,
      requested_at,
      status,
      status_message,
      foreign_author_id,
      foreign_book_id,
      foreign_edition_id,
      readarr_author_id,
      readarr_book_id,
      readarr_edition_id,
      cover_url,
      notes,
      last_synced_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertStatusHistoryStatement = database.prepare(`
    INSERT INTO status_history (
      book_request_id,
      old_status,
      new_status,
      message,
      changed_at
    ) VALUES (?, ?, ?, ?, ?)
  `);

  function findById(id: number) {
    const row = getByIdStatement.get(id) as BookRequestRow | undefined;
    return row ? mapBookRequest(row) : null;
  }

  function recordStatusChange(
    bookRequestId: number,
    oldStatus: BookRequestStatus | null,
    newStatus: BookRequestStatus,
    message: string | null,
    changedAt: string,
  ) {
    insertStatusHistoryStatement.run(
      bookRequestId,
      oldStatus,
      newStatus,
      message,
      changedAt,
    );
  }

  return {
    listByUser(userId: number): BookRequestRecord[] {
      return listByUserStatement
        .all(userId)
        .map((row) => mapBookRequest(row as BookRequestRow));
    },

    listAll(): BookRequestRecord[] {
      return listAllStatement.all().map((row) => mapBookRequest(row as BookRequestRow));
    },

    findById,

    findByUserAndFingerprint(userId: number, fingerprint: string) {
      const row = getByUserAndFingerprintStatement.get(userId, fingerprint) as
        | BookRequestRow
        | undefined;
      return row ? mapBookRequest(row) : null;
    },

    findByFingerprintsForUser(userId: number, fingerprints: string[]) {
      if (fingerprints.length === 0) {
        return [] as BookRequestRecord[];
      }

      const statement = database.prepare(
        `${selectBase}
         WHERE book_requests.user_id = ?
         AND book_requests.request_fingerprint IN (${makePlaceholders(fingerprints.length)})
         ORDER BY book_requests.updated_at DESC, book_requests.id DESC`,
      );

      return statement
        .all(userId, ...fingerprints)
        .map((row) => mapBookRequest(row as BookRequestRow));
    },

    findLatestByFingerprints(fingerprints: string[]) {
      if (fingerprints.length === 0) {
        return [] as BookRequestRecord[];
      }

      const statement = database.prepare(
        `${selectBase}
         WHERE book_requests.request_fingerprint IN (${makePlaceholders(fingerprints.length)})
         ORDER BY book_requests.updated_at DESC, book_requests.id DESC`,
      );

      return statement
        .all(...fingerprints)
        .map((row) => mapBookRequest(row as BookRequestRow));
    },

    create(input: CreateBookRequestInput) {
      const result = insertStatement.run(
        input.userId,
        input.requestFingerprint,
        input.requestedTitle,
        input.requestedAuthor,
        input.requestedYear,
        input.requestedAt,
        input.status,
        input.statusMessage,
        input.foreignAuthorId,
        input.foreignBookId,
        input.foreignEditionId,
        input.readarrAuthorId,
        input.readarrBookId,
        input.readarrEditionId,
        input.coverUrl,
        input.notes,
        input.lastSyncedAt,
        input.createdAt,
        input.updatedAt,
      );

      recordStatusChange(
        Number(result.lastInsertRowid),
        null,
        input.status,
        input.statusMessage,
        input.createdAt,
      );

      return findById(Number(result.lastInsertRowid));
    },

    update(id: number, patch: UpdateBookRequestInput) {
      const current = findById(id);
      if (!current) {
        return null;
      }

      const entries = [
        ["request_fingerprint", patch.requestFingerprint],
        ["requested_title", patch.requestedTitle],
        ["requested_author", patch.requestedAuthor],
        ["requested_year", patch.requestedYear],
        ["requested_at", patch.requestedAt],
        ["status", patch.status],
        ["status_message", patch.statusMessage],
        ["foreign_author_id", patch.foreignAuthorId],
        ["foreign_book_id", patch.foreignBookId],
        ["foreign_edition_id", patch.foreignEditionId],
        ["readarr_author_id", patch.readarrAuthorId],
        ["readarr_book_id", patch.readarrBookId],
        ["readarr_edition_id", patch.readarrEditionId],
        ["cover_url", patch.coverUrl],
        ["notes", patch.notes],
        ["last_synced_at", patch.lastSyncedAt],
        ["created_at", patch.createdAt],
      ] as const;

      const fields: string[] = [];
      const values: unknown[] = [];

      for (const [column, value] of entries) {
        if (value === undefined) {
          continue;
        }

        fields.push(`${column} = ?`);
        values.push(value);
      }

      const updatedAt = patch.updatedAt ?? new Date().toISOString();
      fields.push("updated_at = ?");
      values.push(updatedAt);

      if (fields.length === 1) {
        return current;
      }

      const updateStatement = database.prepare(
        `UPDATE book_requests SET ${fields.join(", ")} WHERE id = ?`,
      );

      updateStatement.run(...values, id);

      if (patch.status && patch.status !== current.status) {
        recordStatusChange(
          id,
          current.status,
          patch.status,
          patch.statusMessage ?? current.statusMessage,
          updatedAt,
        );
      }

      return findById(id);
    },
  };
}
