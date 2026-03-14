# Kindling

Kindling is a small, family-friendly web app that sits in front of Readarr. It keeps the experience book-first and calm:

- View the books a family member has requested
- Request a new EPUB or audiobook with one simple search flow
- Keep local request history in SQLite even when Readarr is unreliable
- Edit profile names and Kindle email addresses
- Watch a folder tree and auto-send matched EPUBs to Kindle by SMTP
- Manually send any matched EPUB to any configured Kindle from the household view

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
AUDIOBOOK_READARR_BASE_URL=http://localhost:8788
AUDIOBOOK_READARR_API_KEY=your-audiobook-readarr-api-key
```

4. Optional: set `READARR_ROOT_FOLDER_PATH`, `READARR_QUALITY_PROFILE_ID`, and `READARR_METADATA_PROFILE_ID` if you do not want Kindling to fall back to the first available EPUB Readarr root folder/profile values.
5. Optional: set `AUDIOBOOK_READARR_ROOT_FOLDER_PATH`, `AUDIOBOOK_READARR_QUALITY_PROFILE_ID`, and `AUDIOBOOK_READARR_METADATA_PROFILE_ID` if you want the audiobook Readarr to use specific root folder/profile values.
6. Optional: set the SMTP values if you want Kindle delivery:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM_EMAIL=kindling@example.com
```

7. Set the household access values before exposing Kindling anywhere beyond localhost:

```env
KINDLING_ADMIN_PASSWORD=choose-a-strong-household-password
KINDLING_SESSION_SECRET=use-a-long-random-secret
```

8. Run the setup scripts:

```powershell
npm install
npm run db:migrate
npm run db:seed
```

9. Start the app:

```powershell
npm run dev
```

10. Start the automatic delivery worker in a second terminal if you want watched-folder scanning:

```powershell
npm run worker
```

11. Open [http://localhost:3000](http://localhost:3000).

## Profiles

Kindling seeds a tiny local family list for v1:

- Mum
- Dad
- Adam

The seed script is safe to rerun, and the app only auto-seeds these defaults when the database is empty. After that, profile names and Kindle email addresses can be edited in the `All requests` screen.

## Scripts

```powershell
npm run dev
npm run build
npm run start
npm run worker
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
| `AUDIOBOOK_READARR_BASE_URL` | Yes for audiobook requests | Base URL for the audiobook Readarr instance |
| `AUDIOBOOK_READARR_API_KEY` | Yes for audiobook requests | Audiobook Readarr API key used as `X-Api-Key` |
| `AUDIOBOOK_READARR_ROOT_FOLDER_PATH` | No | Override the audiobook Readarr root folder used when adding authors/books |
| `AUDIOBOOK_READARR_QUALITY_PROFILE_ID` | No | Override the audiobook quality profile id |
| `AUDIOBOOK_READARR_METADATA_PROFILE_ID` | No | Override the audiobook metadata profile id |
| `READARR_SYNC_INTERVAL_SECONDS` | No | How often active requests are auto-refreshed |
| `SMTP_HOST` | Yes for Kindle delivery | SMTP host used to email files to Kindle |
| `SMTP_PORT` | No | SMTP port. Defaults to `587` |
| `SMTP_SECURE` | No | Use SMTPS/TLS directly. Defaults to `false` |
| `SMTP_USERNAME` | No | SMTP username if your server requires auth |
| `SMTP_PASSWORD` | No | SMTP password if your server requires auth |
| `SMTP_FROM_EMAIL` | Yes for Kindle delivery | Sender address used by Kindling |
| `KINDLING_ADMIN_PASSWORD` | Yes for production | Household password used to unlock the UI and API |
| `KINDLING_SESSION_SECRET` | Yes for production | Secret used to sign the Kindling session cookie |
| `KINDLING_SESSION_TTL_HOURS` | No | How long the unlock session lasts. Defaults to `168` |
| `KINDLING_EMBEDDED_WORKER` | No | Enables the old in-process worker for local development only. Defaults to `false` |
| `DELIVERY_SCAN_INTERVAL_SECONDS` | No | How often the watched folder is rescanned |

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
- `app_settings`
- `delivery_attempts`

`book_requests` stores the app-side source of truth, including:

- who requested the book
- the requested title/author/year snapshot
- friendly status
- linked Readarr ids when available
- cover URL and sync timestamps
- last matched local file path
- latest Kindle delivery snapshot

## Internal App API

- `GET /api/users`
- `PATCH /api/users/:id`
- `GET /api/auth/session`
- `POST /api/auth/session`
- `GET /api/requests?userId=...`
- `POST /api/requests`
- `GET /api/search?q=...&userId=...`
- `POST /api/requests/:id/sync`
- `DELETE /api/requests/:id`
- `POST /api/requests/:id/deliver`
- `GET /api/settings/delivery`
- `PUT /api/settings/delivery`
- `GET /api/health`

## Architecture Summary

Kindling keeps Readarr behind a server-side adapter in `lib/readarr/`. The browser never calls Readarr directly. The local SQLite database is the source of truth for "My Books", so failed Readarr actions still leave a visible request trail for the family.

The request flow is:

1. Save the request locally first.
2. Route EPUB requests to the main Readarr instance and audiobook requests to the audiobook Readarr instance.
3. Ask the chosen Readarr to ensure the author exists.
4. Add or reuse the requested book.
5. Monitor the book and trigger a search when possible.
6. Sync Readarr status back into the local request record.

## Readarr Integration Notes

- Readarr is treated as an archived/retired backend dependency, so the adapter intentionally stays small and defensive.
- Kindling keeps the UI book-centric even though Readarr has author-level operations under the hood.
- Audiobooks use a separate Readarr instance because Readarr itself cannot distinguish audiobook ownership from EPUB ownership.
- If Readarr fails during creation, the request stays visible locally with a failed status and message.
- Deleting a request clears any imported Readarr files it can find, unmonitors the book, and resets the local request to `Not Monitored` so it can be requested again later.

## Kindle Delivery

Kindling now includes a watched-folder matcher plus an SMTP-based Kindle sender for EPUB requests. The watched folder path is configured in the `All requests` screen and scanned by the dedicated `npm run worker` process. When a requested ebook file appears there, Kindling marks the request as ready and only auto-sends when the match is exact enough to be safe.
