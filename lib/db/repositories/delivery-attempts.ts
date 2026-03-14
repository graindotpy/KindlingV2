import type Database from "better-sqlite3";
import { getDb } from "@/lib/db/client";
import type {
  DeliveryAttemptRecord,
  DeliveryAttemptStatus,
  DeliveryTrigger,
} from "@/lib/delivery/types";

type DeliveryAttemptRow = {
  id: number;
  book_request_id: number;
  recipient_user_id: number | null;
  recipient_name: string;
  recipient_email: string;
  file_path: string;
  trigger: DeliveryTrigger;
  status: DeliveryAttemptStatus;
  message: string | null;
  created_at: string;
  sent_at: string | null;
};

function mapDeliveryAttempt(row: DeliveryAttemptRow): DeliveryAttemptRecord {
  return {
    id: row.id,
    bookRequestId: row.book_request_id,
    recipientUserId: row.recipient_user_id,
    recipientName: row.recipient_name,
    recipientEmail: row.recipient_email,
    filePath: row.file_path,
    trigger: row.trigger,
    status: row.status,
    message: row.message,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

export type CreateDeliveryAttemptInput = {
  bookRequestId: number;
  recipientUserId: number | null;
  recipientName: string;
  recipientEmail: string;
  filePath: string;
  trigger: DeliveryTrigger;
  status: DeliveryAttemptStatus;
  message: string | null;
  createdAt: string;
  sentAt: string | null;
};

export function createDeliveryAttemptsRepository(database: Database.Database = getDb()) {
  const getByIdStatement = database.prepare(`
    SELECT
      id,
      book_request_id,
      recipient_user_id,
      recipient_name,
      recipient_email,
      file_path,
      trigger,
      status,
      message,
      created_at,
      sent_at
    FROM delivery_attempts
    WHERE id = ?
  `);
  const createStatement = database.prepare(`
    INSERT INTO delivery_attempts (
      book_request_id,
      recipient_user_id,
      recipient_name,
      recipient_email,
      file_path,
      trigger,
      status,
      message,
      created_at,
      sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findMatchingAutomaticAttemptStatement = database.prepare(`
    SELECT
      id,
      book_request_id,
      recipient_user_id,
      recipient_name,
      recipient_email,
      file_path,
      trigger,
      status,
      message,
      created_at,
      sent_at
    FROM delivery_attempts
    WHERE book_request_id = ?
      AND trigger = ?
      AND recipient_email = ?
      AND file_path = ?
      AND status = 'sent'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);

  return {
    findById(id: number) {
      const row = getByIdStatement.get(id) as DeliveryAttemptRow | undefined;
      return row ? mapDeliveryAttempt(row) : null;
    },

    create(input: CreateDeliveryAttemptInput) {
      const result = createStatement.run(
        input.bookRequestId,
        input.recipientUserId,
        input.recipientName,
        input.recipientEmail,
        input.filePath,
        input.trigger,
        input.status,
        input.message,
        input.createdAt,
        input.sentAt,
      );

      return this.findById(Number(result.lastInsertRowid));
    },

    findMatchingAutomaticAttempt(
      bookRequestId: number,
      trigger: DeliveryTrigger,
      recipientEmail: string,
      filePath: string,
    ) {
      const row = findMatchingAutomaticAttemptStatement.get(
        bookRequestId,
        trigger,
        recipientEmail,
        filePath,
      ) as DeliveryAttemptRow | undefined;

      return row ? mapDeliveryAttempt(row) : null;
    },
  };
}
