ALTER TABLE users ADD COLUMN kindle_email TEXT;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE book_requests ADD COLUMN matched_file_path TEXT;
ALTER TABLE book_requests ADD COLUMN matched_at TEXT;
ALTER TABLE book_requests ADD COLUMN last_delivery_at TEXT;
ALTER TABLE book_requests ADD COLUMN last_delivery_recipient TEXT;
ALTER TABLE book_requests ADD COLUMN last_delivery_trigger TEXT;
ALTER TABLE book_requests ADD COLUMN last_delivery_message TEXT;

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_request_id INTEGER NOT NULL,
  recipient_user_id INTEGER,
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  file_path TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY(book_request_id) REFERENCES book_requests(id) ON DELETE CASCADE,
  FOREIGN KEY(recipient_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_book_request_id
  ON delivery_attempts (book_request_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_auto_match
  ON delivery_attempts (book_request_id, trigger, recipient_email, file_path);
