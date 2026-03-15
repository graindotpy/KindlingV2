import type Database from "better-sqlite3";
import { getDb } from "@/lib/db/client";
import type {
  BookRequestFormat,
  BookRequestRecord,
  BookRequestStatus,
} from "@/lib/requests/types";

type BookRequestRow = {
  id: number;
  user_id: number;
  user_name: string;
  request_format: BookRequestFormat;
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
  search_attempt_count: number;
  next_search_attempt_at: string | null;
  last_search_attempt_at: string | null;
  last_search_error_message: string | null;
  last_synced_at: string | null;
  matched_file_path: string | null;
  matched_at: string | null;
  last_delivery_at: string | null;
  last_delivery_recipient: string | null;
  last_delivery_trigger: "automatic" | "manual" | null;
  last_delivery_message: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateBookRequestInput = {
  userId: number;
  requestFormat: BookRequestFormat;
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
  searchAttemptCount: number;
  nextSearchAttemptAt: string | null;
  lastSearchAttemptAt: string | null;
  lastSearchErrorMessage: string | null;
  lastSyncedAt: string | null;
  matchedFilePath: string | null;
  matchedAt: string | null;
  lastDeliveryAt: string | null;
  lastDeliveryRecipient: string | null;
  lastDeliveryTrigger: "automatic" | "manual" | null;
  lastDeliveryMessage: string | null;
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
    requestFormat: row.request_format,
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
    searchAttemptCount: row.search_attempt_count,
    nextSearchAttemptAt: row.next_search_attempt_at,
    lastSearchAttemptAt: row.last_search_attempt_at,
    lastSearchErrorMessage: row.last_search_error_message,
    lastSyncedAt: row.last_synced_at,
    matchedFilePath: row.matched_file_path,
    matchedAt: row.matched_at,
    lastDeliveryAt: row.last_delivery_at,
    lastDeliveryRecipient: row.last_delivery_recipient,
    lastDeliveryTrigger: row.last_delivery_trigger,
    lastDeliveryMessage: row.last_delivery_message,
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
      book_requests.request_format,
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
      book_requests.search_attempt_count,
      book_requests.next_search_attempt_at,
      book_requests.last_search_attempt_at,
      book_requests.last_search_error_message,
      book_requests.last_synced_at,
      book_requests.matched_file_path,
      book_requests.matched_at,
      book_requests.last_delivery_at,
      book_requests.last_delivery_recipient,
      book_requests.last_delivery_trigger,
      book_requests.last_delivery_message,
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
  const listPendingSearchRetriesStatement = database.prepare(
    `${selectBase}
     WHERE book_requests.status = 'requested'
     AND book_requests.next_search_attempt_at IS NOT NULL
     AND book_requests.next_search_attempt_at <= ?
     ORDER BY book_requests.next_search_attempt_at ASC, book_requests.requested_at ASC, book_requests.id ASC`,
  );
  const hasPendingSearchRetriesStatement = database.prepare(
    `SELECT 1
     FROM book_requests
     WHERE status = 'requested'
     AND next_search_attempt_at IS NOT NULL
     LIMIT 1`,
  );
  const getByUserAndFingerprintStatement = database.prepare(
    `${selectBase}
     WHERE book_requests.user_id = ?
     AND book_requests.request_fingerprint = ?
     AND book_requests.request_format = ?`,
  );
  const insertStatement = database.prepare(`
    INSERT INTO book_requests (
      user_id,
      request_format,
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
      search_attempt_count,
      next_search_attempt_at,
      last_search_attempt_at,
      last_search_error_message,
      last_synced_at,
      matched_file_path,
      matched_at,
      last_delivery_at,
      last_delivery_recipient,
      last_delivery_trigger,
      last_delivery_message,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    hasPendingSearchRetries() {
      return Boolean(hasPendingSearchRetriesStatement.get());
    },

    listPendingSearchRetries(cutoff: string) {
      return listPendingSearchRetriesStatement
        .all(cutoff)
        .map((row) => mapBookRequest(row as BookRequestRow));
    },

    findByUserAndFingerprint(
      userId: number,
      fingerprint: string,
      requestFormat: BookRequestFormat,
    ) {
      const row = getByUserAndFingerprintStatement.get(
        userId,
        fingerprint,
        requestFormat,
      ) as
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
        input.requestFormat,
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
        input.searchAttemptCount,
        input.nextSearchAttemptAt,
        input.lastSearchAttemptAt,
        input.lastSearchErrorMessage,
        input.lastSyncedAt,
        input.matchedFilePath,
        input.matchedAt,
        input.lastDeliveryAt,
        input.lastDeliveryRecipient,
        input.lastDeliveryTrigger,
        input.lastDeliveryMessage,
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
        ["request_format", patch.requestFormat],
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
        ["search_attempt_count", patch.searchAttemptCount],
        ["next_search_attempt_at", patch.nextSearchAttemptAt],
        ["last_search_attempt_at", patch.lastSearchAttemptAt],
        ["last_search_error_message", patch.lastSearchErrorMessage],
        ["last_synced_at", patch.lastSyncedAt],
        ["matched_file_path", patch.matchedFilePath],
        ["matched_at", patch.matchedAt],
        ["last_delivery_at", patch.lastDeliveryAt],
        ["last_delivery_recipient", patch.lastDeliveryRecipient],
        ["last_delivery_trigger", patch.lastDeliveryTrigger],
        ["last_delivery_message", patch.lastDeliveryMessage],
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
