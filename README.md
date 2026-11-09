# Kindling

A household book request app for **two Readarr instances**: one for ebooks and one for audiobooks. Family members choose a profile, search for a book, and request the format they want. Kindling keeps request history in SQLite and can send downloaded EPUBs to Kindle by email.

For title and ISBN searches, Kindling uses Open Library to identify the intended work and its author's Goodreads ID, then searches Readarr with `author:<id>` and filters the returned catalogue back to that title. Ambiguous titles show a “Did you mean…” selector. If the author catalogue does not return a verified match, Kindling makes one bounded standard Readarr search using the user's original query and still verifies both title and Goodreads author ID. Explicit Goodreads/Readarr identifiers keep their direct lookup path, and Open Library failures fall back to Readarr's standard search with a visible warning.

Docker now runs the web app and its background worker in **one container**, with one configuration file. Database migrations and initial profiles are created automatically. Existing requests, profiles and delivery settings are retained when the same data folder is mounted.

See the [project review](docs/PROJECT_REVIEW.md) for the search fixes, interface changes, validation and remaining Readarr metadata limitations. Removing a request now removes it from the person's list while preserving the household's Readarr files and monitoring.

## Automatic deploys to the Zima

Deploys automatically to the Zima from main via GHCR + WUD.

1. Every push to `main` runs [`publish.yml`](.github/workflows/publish.yml). It runs the full CI checks (lint, typecheck, unit and browser tests, build) from [`ci.yml`](.github/workflows/ci.yml). Only if they pass does it build the Dockerfile and push `ghcr.io/graindotpy/kindlingv2:edge` and `:sha-<short sha>`, labelled with the commit SHA (`org.opencontainers.image.revision`). If several pushes land close together, only the newest one publishes.
2. On the Zima, `/DATA/AppData/kindling/docker-compose.yml` runs `ghcr.io/graindotpy/kindlingv2:edge` with WUD labels. The `nuzlocke-wud` updater checks the `:edge` digest at the top of every hour. When the digest changes, it pulls the new image and recreates `kindling` (`docker.apps` trigger, no pruning) and posts the update to the Zima Discord channel. Expect a new commit to be live within about an hour.

Check the running revision. Read it from the image, not the container: WUD copies the old container's labels when it recreates it.

```sh
docker image inspect "$(docker inspect kindling --format '{{.Image}}')" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

### Roll back

In `/DATA/AppData/kindling`, change the `image:` line in `docker-compose.yml` to an older build. Use either `ghcr.io/graindotpy/kindlingv2:sha-<old short sha>` or the last locally built image, `kindling:local`. Then run:

```sh
docker compose up -d
```

A pinned `sha-` tag or `kindling:local` is not `:edge`, so WUD will not replace it. To resume automatic deploys, set the image back to `:edge` and run `docker compose up -d`.

`deploy/Deploy-Kindling.ps1` still works for a one-off local build. While the compose file points at `:edge`, the next published `:edge` image will overwrite that local build.

## Install on ZimaOS with Docker Compose

Use a persistent folder on your ZimaOS machine for this checkout, for example `/DATA/AppData/kindling`. The commands below run in that folder. Docker with Compose is required; Node.js is only needed when developing outside Docker.

1. Copy the example configuration:

   ```sh
   cp .env.example .env
   ```

2. Edit `.env`. Set these six values:

   ```dotenv
   KINDLING_ADMIN_PASSWORD='a-long-household-password'
   KINDLING_SESSION_SECRET='a-random-secret-at-least-32-characters-long'
   READARR_BASE_URL=http://192.168.1.50:8787
   READARR_API_KEY=your-ebook-readarr-api-key
   AUDIOBOOK_READARR_BASE_URL=http://192.168.1.50:8788
   AUDIOBOOK_READARR_API_KEY=your-audiobook-readarr-api-key
   ```

   Replace the example address with your server's LAN address and the actual published Readarr ports. **`localhost` inside the Kindling container points to Kindling**, so it will not reach another container or your ZimaOS host. Include Readarr's URL base if one is configured, such as `http://192.168.1.50:8787/readarr`. Single-quote secrets containing `$` or `#` in `.env`.

   To generate a session secret using Docker:

   ```sh
   docker run --rm node:22-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. Prepare the persistent folders. The app runs as UID/GID `1000:1000` by default:

   ```sh
   mkdir -p data watched-books
   sudo chown -R 1000:1000 data
   chmod 600 .env
   ```

   Only change ownership of Kindling's data directory. If your NAS uses different permissions, set `KINDLING_UID` and `KINDLING_GID` in `.env` to a user/group that can write the data directory and read your ebook library.

4. Start Kindling:

   ```sh
   docker compose up -d --build
   docker compose ps
   ```

   Open `http://<your-zimaos-ip>:3000`. The first build takes longer because it installs dependencies and compiles the app. The container should become healthy after startup. To change the port, add `KINDLING_PORT=3001` to `.env` and run `docker compose up -d` again.

Use the household password to unlock the app. Existing profile names can be changed in the household settings. A fresh database initially contains Mum, Dad and Adam.

### ZimaOS custom-app interface

For an app tile managed from ZimaOS, first build the image on that machine:

```sh
docker build -t kindling:local .
```

Then import [`deploy/docker-compose.zimaos.yml`](deploy/docker-compose.zimaos.yml) through ZimaOS's custom-app interface. Fill in the Readarr URLs, keys, household password and session secret in the app settings. Adjust the host folder paths and icon URL to your server before installing and prepare the data folder permissions as above. This template uses your locally built image. A published image is also available as `ghcr.io/graindotpy/kindlingv2:edge` (see above). Choose either this installation method or the command-line Compose method to avoid two apps competing for the same port and database.

The template follows the official [ZimaOS Compose and app metadata reference](https://www.zimaspace.com/docs/developer/app-store-compose-x-casaos).

## Move an existing two-container installation

1. Record your existing environment settings and the **actual host directory** mounted at `/app/data`. Preserve your ebook library mount as well.
2. Stop both old containers (`kindling-web` and `kindling-worker`) in ZimaOS. Keep their data directory.
3. With both stopped, copy the entire data directory to a backup location. Include `kindling.db-wal` and `kindling.db-shm` if present.
4. Put the previous settings in `.env` or the new custom-app settings. For Compose, set `KINDLING_DATA_DIR=/absolute/path/to/existing/data` if it differs from `./data`. Set `KINDLING_BOOKS_DIR` to the existing ebook library path.
5. Ensure the new container's UID/GID can write that data directory, then start the new container. It applies migrations before either application process starts.
6. Confirm your household profiles and request history appear and check the connections in settings. Remove the old stopped containers only after verifying the new app.

Do not run the old worker alongside the new container: both would process delivery and search jobs.

## Kindle delivery

Keep your current SMTP settings if delivery already works. To enable it on a fresh install, set `SMTP_HOST`, `SMTP_FROM_EMAIL`, and any required `SMTP_USERNAME` / `SMTP_PASSWORD` in `.env`. Port `587` with `SMTP_SECURE=false` is the default; use the settings supplied by your mail provider.

Point `KINDLING_BOOKS_DIR` at the **host directory containing downloaded EPUBs**, for example:

```dotenv
KINDLING_BOOKS_DIR=/DATA/Media/Books
```

Recreate the container after changing its mounts. In Kindling's delivery settings, set the watched folder to `/watched-books`, the path **inside the container**. This mount is read-only: Kindling only needs to read books to attach them to email. Use the same container path as before if you need to preserve previously matched file paths, or rescan after changing it.

Add each person's Kindle email in household settings and approve the SMTP sender in Amazon's personal document settings. Automatic sending requires a sufficiently confident file match; manual sending is also available for matched EPUBs. Only EPUB and PDF files are sent, because Amazon's Send to Kindle no longer accepts MOBI or AZW. Audiobooks remain in the audiobook Readarr instance and are not emailed to Kindle.

The default raw attachment limit is 18 MiB (`SMTP_MAX_ATTACHMENT_BYTES=18874368`) to leave room for email encoding. SMTP acceptance means the email was sent; Amazon controls final Kindle delivery.

## Update, back up and restore

### One-command ZimaOS deployment

From Windows PowerShell in the repository, run:

```powershell
.\deploy\Deploy-Kindling.ps1
```

The defaults target `admin@192.168.4.148`, `/DATA/AppData/kindling`, the `kindling` Compose service and the `kindling:local` image used by this installation. Override them when needed, for example:

```powershell
.\deploy\Deploy-Kindling.ps1 -Target admin@zima-host -RemoteAppDir /DATA/AppData/kindling
```

By default the script runs lint, type checking and unit tests, packages the current working tree, rejects private or generated files, verifies the uploaded SHA-256, and performs the deployment through one interactive SSH session. Use `-SkipChecks` only when that exact working tree has already passed the checks. `-DryRun -SkipChecks` exercises packaging and privacy validation without contacting the server.

On ZimaOS the helper serializes deployments, builds an immutable candidate without replacing the running image, then takes an online SQLite backup and a root-only `.env` backup immediately before activation. It preserves the running image by ID, recreates the existing Compose service and waits for the container's internal app/database/worker health check. If activation fails, it restores the previous image automatically. When database migrations changed, it also restores the pre-deployment database; failed-release database files are retained for investigation. The script never changes the live `.env`, prunes Docker data or packages local secrets.

Successful deployments intentionally retain their release/rollback image tags and pre-deployment backups. Review retention periodically; the deployer does not guess which recovery points are safe to delete.

Password-based SSH can prompt once for the upload, once for the remote session and once for `sudo`. Installing an SSH public key for `admin` removes the first two prompts while retaining the ZimaOS `sudo` boundary.

### Back up while Kindling is running

```sh
docker compose exec kindling node dist/backup.cjs
```

The command prints a timestamped backup path under `/app/data/backups`. It uses SQLite's online backup API, including committed data in the write-ahead log. Copy this backup to another disk or machine, and separately keep a secure copy of `.env`. The database backup includes profiles, requests, settings and delivery history; ebook files live in your library and need their own backup.

For a ZimaOS custom-app install, use `docker exec kindling node dist/backup.cjs` instead. Never copy only `kindling.db` while the application is running, because recent data may still be in its WAL file.

### Upgrade

Make a backup first. Keep a copy or tag of the previous image if you need an easy rollback:

```sh
docker image tag kindling:local kindling:previous
```

Update the source checkout to the desired revision, then:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 kindling
```

For a custom-app install, rebuild `kindling:local` and recreate the app using that image in ZimaOS. Restarting an existing container alone does not replace its image. Configuration changes in `.env` also require `docker compose up -d` to recreate the container.

### Restore or roll back

Stop Kindling first. Move its current database **and any matching `-wal` / `-shm` files** into a separate safety-copy folder. Copy the chosen backup to the configured database filename (normally `data/kindling.db`) and restore write permissions for the container user. Restart Kindling and check the household view.

If rolling back application code after a schema change, restore the database backup taken before that upgrade as well. To reuse the previous image with Compose, tag it as `kindling:local` and start with `docker compose up -d --no-build --force-recreate`.

## Book metadata provider

Readarr's original metadata service is gone, so each Readarr instance needs a replacement "Metadata Provider Source". The shared public instance (`https://api.bookinfo.pro`) can go down for long periods; when it does, every Readarr search waits about 20 seconds and returns nothing, and Kindling reports that Readarr's book catalogue took too long.

`deploy/metadata` runs our own copy of [rreading-glasses](https://github.com/blampe/rreading-glasses) in Goodreads mode on the Zima, shared by both Readarr instances. Goodreads mode keeps the IDs that existing Readarr libraries and Kindling's author searches use, so no library rebuild is needed.

1. Copy `deploy/metadata` to the Zima and run `sudo bash deploy-zimaos.sh` from that folder. It installs to `/DATA/AppData/kindling-metadata`, generates the Postgres password, starts the stack and waits for the provider on port 8788 (`METADATA_PORT=<port>` changes it).
2. Point each Readarr at it. The helper prints the previous value so you can switch back the same way:

   ```bash
   bash set-readarr-metadata-source.sh http://192.168.4.148:8787 /DATA/AppData/readarr/config/config.xml http://192.168.4.148:8788
   bash set-readarr-metadata-source.sh http://192.168.4.148:8888 /DATA/AppData/readarr-audio/config/config.xml http://192.168.4.148:8788
   ```

The first search for an author can return an incomplete list of works while the provider loads them in the background; searching again a minute later fills it in. To roll back, run the helper with the old source URL. The Hardcover pilot in `deploy/hardcover-pilot` is a separate experiment and needs fresh Readarr databases.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Search reports Readarr unavailable | Check the correct LAN IP, port, API key and URL base for the selected format. Open that Readarr instance from another device on the same network. |
| Readarr lookup fails despite a reachable instance | Readarr's metadata provider can fail independently of its web interface. Time it directly, for example `curl -w '%{http_code} %{time_total}\n' -o /dev/null <metadata source>/author/31232`; a 5xx or a ~20 second wait means the provider is down (see [Book metadata provider](#book-metadata-provider)). Kindling reports that failure and keeps saved requests. |
| A resolved search stalls in Readarr | Check the Readarr logs for `BookInfoProxy` and HTTP 429 backoffs. Kindling bounds the author lookup and makes one final standard search with the original query; it does not retry `/book/lookup` after that final attempt. |
| Some books appear but an expected title is missing | Choose the matching Open Library title and author when prompted. Kindling then filters Readarr's author catalogue; Readarr still needs that work in its metadata results. |
| Open Library warning appears | Kindling retries one temporary network/provider failure before falling back to Readarr. Check internet access from the container and run `docker logs --tail=100 kindling` for a sanitized reason such as `timeout`, `econnreset` or `http-429`; existing direct identifiers still work. |
| Request is saved but cannot be added | Confirm that the target Readarr has a root folder, quality profile and metadata profile. Optional environment overrides must refer to that same instance. |
| Container keeps restarting | Read `docker compose logs --tail=100 kindling`. Common causes are invalid settings or an unwritable database directory. |
| Container is unhealthy | `/api/health/live` checks the local database and worker heartbeat. Provider connectivity is shown separately in Kindling's authenticated settings. Docker marks failed probes unhealthy; it restarts the container if a supervised process exits. |
| Worker reports an error but the app is healthy | The worker is alive but a Readarr/delivery task failed. Check the settings message and logs, fix that connection or folder, then allow the next cycle to run. |
| Watched folder is missing | Mount the correct host library and use the container path `/watched-books` in Kindling. Check that the container user can read the files and traverse parent folders. |
| Kindle email fails | Check the recipient, approved sender, SMTP details, attachment size and the delivery message. |
| "Too many incorrect passwords" | After 5 wrong passwords from one address, or 30 across the household, unlocking pauses for up to 15 minutes. Wait, or restart the container to clear it. Devices that are already unlocked are not affected. |
| "That search result has expired" | Requests use Kindling's own recent search results (kept for 30 minutes, and cleared when the container restarts). Search for the book again and request it from the new results. |
| Actions fail behind a proxy | Set `KINDLING_TRUSTED_ORIGINS=https://your-kindling-hostname` to the exact public origin, then recreate the container. |

## Configuration reference

Keep secrets in `.env` or ZimaOS environment settings. They are excluded from Git and Docker build context. The browser calls Kindling's API; Readarr API keys stay on the server.

| Variable | Default / purpose |
| --- | --- |
| `READARR_BASE_URL`, `READARR_API_KEY` | Ebook Readarr connection |
| `AUDIOBOOK_READARR_BASE_URL`, `AUDIOBOOK_READARR_API_KEY` | Audiobook Readarr connection |
| `OPENLIBRARY_CONTACT_EMAIL` | Optional contact sent only to Open Library to identify API requests and receive its higher rate limit |
| `READARR_ROOT_FOLDER_PATH` | Optional ebook root folder override; a path inside Readarr, not Kindling |
| `READARR_QUALITY_PROFILE_ID`, `READARR_METADATA_PROFILE_ID` | Optional ebook profile IDs; otherwise use available Readarr defaults |
| `AUDIOBOOK_READARR_ROOT_FOLDER_PATH` | Optional audiobook root folder override |
| `AUDIOBOOK_READARR_QUALITY_PROFILE_ID`, `AUDIOBOOK_READARR_METADATA_PROFILE_ID` | Optional audiobook profile IDs |
| `READARR_SYNC_INTERVAL_SECONDS` | `120`; minimum age before a request's remote status is refreshed |
| `KINDLING_ADMIN_PASSWORD` | Household unlock password; required in production |
| `KINDLING_SESSION_SECRET` | Random cookie-signing secret; required in production |
| `KINDLING_TRUSTED_ORIGINS` | Optional comma- or space-separated public origins behind a reverse proxy |
| `KINDLING_SESSION_TTL_HOURS` | `168`; session lifetime |
| `KINDLING_PORT` | `3000`; Compose host port |
| `KINDLING_DATA_DIR` | `./data`; Compose host database directory |
| `KINDLING_BOOKS_DIR` | `./watched-books`; Compose host ebook directory, mounted read-only |
| `KINDLING_UID`, `KINDLING_GID` | `1000`, `1000`; Compose container user/group |
| `DATABASE_PATH` | `./data/kindling.db` locally; fixed at `/app/data/kindling.db` in the supplied Compose file |
| `SMTP_HOST`, `SMTP_FROM_EMAIL` | Required for Kindle delivery |
| `SMTP_PORT`, `SMTP_SECURE` | `587`, `false`; mail transport settings |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | Optional pair when SMTP authentication is required |
| `SMTP_MAX_ATTACHMENT_BYTES` | `18874368`; raw attachment size ceiling |
| `DELIVERY_SCAN_INTERVAL_SECONDS` | `60`; background work interval |
| `KINDLING_EMBEDDED_WORKER` | `false`; optional in-process worker for local development; always disabled in the managed container |

## Local development

Use Node.js 22.10 or newer. Copy `.env.example` to `.env` and configure it. Existing `.env.local` files are also supported and override `.env` for the local web app and CLI scripts.

```sh
npm ci
npm run dev
```

The database initializes automatically on first use. For automatic status updates, queued retries and Kindle delivery, run `npm run worker` in another terminal, or set `KINDLING_EMBEDDED_WORKER=true` for development and use just the web process. Do not run both worker modes together.

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

For the desktop and mobile browser checks, install Playwright's Chromium once and run:

```sh
npx playwright install chromium
npm run test:browser
```

The browser suite starts its own local server on port `3100`, uses a separate test database, and supplies controlled API responses.

The build produces Next's standalone server plus compiled `dist/init.cjs`, `dist/worker.cjs` and `dist/backup.cjs`. Docker copies only the runtime output, static files and SQL migrations. The [Next.js standalone output documentation](https://nextjs.org/docs/app/api-reference/config/next-config-js/output) explains the server layout; the [Docker process-management documentation](https://docs.docker.com/engine/containers/multi-service_container/) explains the process supervision and init behavior used here.

### Validation and remaining installation checks

Automated tests exercise Readarr responses through controlled fixtures, request persistence, EPUB matching and delivery logic, session security, process supervision, worker heartbeats and shutdown, and SQLite initialization and online backup. These checks do not connect to your Readarr instances or send real Kindle email.

An isolated Windows smoke test of the compiled production output also verified native SQLite loading, Nodemailer attachment generation without sending email, initialization and online backup, supervised web/worker startup, the local health probe and supervisor shutdown. The packaged standalone output was checked for accidental inclusion of environment files, local databases and test data.

The supplied Compose definitions have been checked with Docker Compose. An actual Linux container build/start and import through the ZimaOS custom-app interface still need checking on the target machine: the review workstation's Docker daemon was unavailable. After installing, confirm both Readarr connections in settings, request one book in each format, and test Kindle delivery using your existing SMTP configuration. Keep the old installation's stopped containers and data backup until those checks pass.

## Project layout

- `app/`: pages and authenticated server API routes
- `components/`: household, book request and settings interface
- `lib/readarr/`: separate adapters for ebook and audiobook Readarr
- `lib/requests/`: local request workflow, retries and status updates
- `lib/delivery/`: EPUB matching and SMTP delivery
- `lib/db/`: SQLite repositories and versioned migrations
- `deploy/`: ZimaOS Compose template and one-command deployment automation
- `scripts/`: runtime supervisor, build, initialization, health check and backup
- `tests/`: request, integration boundary, security and worker lifecycle tests

The local database is the source of truth for saved requests. A remote failure leaves a visible request and message rather than discarding the household's request history.
