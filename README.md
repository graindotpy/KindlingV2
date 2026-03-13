# Kindling

Kindling is a small, family-friendly web app that sits in front of Readarr. It keeps the experience book-first and calm:

- View the books a family member has requested
- Request a new book with one simple search flow
- Keep local request history in SQLite even when Readarr is unreliable

## Stack

- Next.js + React + TypeScript
- Node.js route handlers for the internal API
- SQLite via `better-sqlite3`
- Thin Readarr v1 API integration with `X-Api-Key`

## Windows Local Setup

1. Install Node.js 22 or newer.
2. Copy `.env.example` to `.env.local`.
3. Fill in at least:

```env
READARR_BASE_URL=http://localhost:8787
READARR_API_KEY=your-readarr-api-key
```

4. Optional: set `READARR_ROOT_FOLDER_PATH`, `READARR_QUALITY_PROFILE_ID`, and `READARR_METADATA_PROFILE_ID` if you do not want Kindling to fall back to the first available Readarr root folder/profile values.
5. Run the setup scripts:

```powershell
npm install
npm run db:migrate
npm run db:seed
```

6. Start the app:

```powershell
npm run dev
```

7. Open [http://localhost:3000](http://localhost:3000).

## Default Local Users

Kindling seeds a tiny local family list for v1:

- Mum
- Dad
- Adam

The seed script is safe to rerun, and the app also auto-seeds these users if the database is empty.

## Scripts

```powershell
npm run dev
npm run build
npm run start
npm run lint
npm run typecheck
npm run test
npm run db:migrate
npm run db:seed
```

## Environment Variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_PATH` | No | SQLite file path. Defaults to `./data/kindling.db` |
| `READARR_BASE_URL` | Yes for live search/requesting | Base URL for Readarr |
| `READARR_API_KEY` | Yes for live search/requesting | Readarr API key used as `X-Api-Key` |
| `READARR_ROOT_FOLDER_PATH` | No | Override the Readarr root folder used when adding authors/books |
| `READARR_QUALITY_PROFILE_ID` | No | Override the quality profile id |
| `READARR_METADATA_PROFILE_ID` | No | Override the metadata profile id |
| `READARR_SYNC_INTERVAL_SECONDS` | No | How often active requests are auto-refreshed |

## Folder Structure

```text
app/
  api/
  request/
components/
lib/
  db/
  delivery/
  readarr/
  requests/
  users/
tests/
```

## SQLite Schema

Main tables:

- `users`
- `book_requests`
- `status_history`

`book_requests` stores the app-side source of truth, including:

- who requested the book
- the requested title/author/year snapshot
- friendly status
- linked Readarr ids when available
- cover URL and sync timestamps

## Internal App API

- `GET /api/users`
- `GET /api/requests?userId=...`
- `POST /api/requests`
- `GET /api/search?q=...&userId=...`
- `POST /api/requests/:id/sync`
- `GET /api/health`

## Architecture Summary

Kindling keeps Readarr behind a server-side adapter in `lib/readarr/`. The browser never calls Readarr directly. The local SQLite database is the source of truth for "My Books", so failed Readarr actions still leave a visible request trail for the family.

The request flow is:

1. Save the request locally first.
2. Ask Readarr to ensure the author exists.
3. Add or reuse the requested book.
4. Monitor the book and trigger a search when possible.
5. Sync Readarr status back into the local request record.

## Readarr Integration Notes

- Readarr is treated as an archived/retired backend dependency, so the adapter intentionally stays small and defensive.
- Kindling keeps the UI book-centric even though Readarr has author-level operations under the hood.
- If Readarr fails during creation, the request stays visible locally with a failed status and message.

## Future Kindle Hook

The codebase includes a placeholder delivery contract in `lib/delivery/types.ts`. That is where a future SMTP-based EPUB sender or "Send to Kindle" button can plug in once EPUB availability detection is added.
