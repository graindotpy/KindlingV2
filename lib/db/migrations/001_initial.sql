CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS book_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  request_fingerprint TEXT NOT NULL,
  requested_title TEXT NOT NULL,
  requested_author TEXT NOT NULL,
  requested_year INTEGER,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL,
  status_message TEXT,
  foreign_author_id TEXT,
  foreign_book_id TEXT,
  foreign_edition_id TEXT,
  readarr_author_id INTEGER,
  readarr_book_id INTEGER,
  readarr_edition_id INTEGER,
  cover_url TEXT,
  notes TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_request_id INTEGER NOT NULL,
  old_status TEXT,
  new_status TEXT NOT NULL,
  message TEXT,
  changed_at TEXT NOT NULL,
  FOREIGN KEY(book_request_id) REFERENCES book_requests(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_book_requests_user_fingerprint
  ON book_requests (user_id, request_fingerprint);

CREATE INDEX IF NOT EXISTS idx_book_requests_user_requested_at
  ON book_requests (user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_book_requests_foreign_book_id
  ON book_requests (foreign_book_id);

CREATE INDEX IF NOT EXISTS idx_book_requests_readarr_book_id
  ON book_requests (readarr_book_id);
