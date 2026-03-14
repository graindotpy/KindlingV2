ALTER TABLE book_requests
ADD COLUMN request_format TEXT NOT NULL DEFAULT 'ebook';

DROP INDEX IF EXISTS idx_book_requests_user_fingerprint;

CREATE UNIQUE INDEX IF NOT EXISTS idx_book_requests_user_fingerprint_format
  ON book_requests (user_id, request_fingerprint, request_format);

CREATE INDEX IF NOT EXISTS idx_book_requests_request_format
  ON book_requests (request_format);
