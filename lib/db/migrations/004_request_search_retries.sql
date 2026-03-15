ALTER TABLE book_requests ADD COLUMN search_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE book_requests ADD COLUMN next_search_attempt_at TEXT;
ALTER TABLE book_requests ADD COLUMN last_search_attempt_at TEXT;
ALTER TABLE book_requests ADD COLUMN last_search_error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_book_requests_next_search_attempt_at
  ON book_requests (status, next_search_attempt_at);
