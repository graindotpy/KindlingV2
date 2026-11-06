# Kindling project review

Reviewed and refactored September 2026. The existing two-Readarr setup is retained: one instance for ebooks, the other for audiobooks. Existing SQLite history, household profiles, watched-folder settings and Kindle delivery remain supported.

## Findings and implemented changes

| Area | Finding | Change |
| --- | --- | --- |
| Search completeness | `/book/lookup` can omit author and edition details that Kindling required, so valid results were discarded. | Use the complete `/api/v1/search` resources used by Readarr's UI. Retain a compatibility fallback for older or alternative builds. |
| Incorrect results | Fuzzy author enrichment could substitute an unrelated author; numeric instance IDs were trusted across requests. | Resolve fallback authors by exact work ID; verify foreign author/book identities before using local IDs. Status refresh detects reused book IDs. |
| Search inputs | ISBNs and Goodreads links were treated inconsistently; matching and ordering were weak. | Normalize ISBNs, Goodreads book/work/author links and explicit identifiers; rank results and deduplicate by work identity. |
| Outages | Network requests could hang, and empty results obscured provider errors. | Bound network calls and catalogue search time; fall back to each Readarr instance's library, with visible warnings. Preserve successful results when the other format fails. |
| Search UX | Search ran on blur, repeat searches were blocked, and old responses could overwrite current state. | Submit explicitly using the button or Enter; allow repeat searches; cancel and ignore stale requests. Changing profile clears results. |
| Request history | Opening a list waited on remote status requests. Remote unmonitoring/missing books could make saved requests disappear. | Return local history immediately. Update statuses in the worker; retain remote failures visibly with a retry action. |
| Removal | Removing a request deleted Readarr files and changed monitoring shared by the household. | Remove the local list entry only. Keep remote files/monitoring intact, and prevent in-flight status updates from reviving removed entries. |
| Retries | Monitoring errors were swallowed, and historical search timestamps could count as confirmation of a new request. | Preserve monitoring failures for retry, remonitor before searching, and compare search timestamps against the request time. |
| Interface | A large screen component mixed search, profiles, settings and delivery, with inconsistent device-specific layouts. | Split book cards, household settings, transport and icons into focused components. Use one responsive theme, accessible labels/focus, loading/error states and explanatory format buttons. |
| Unlock | Missing production authentication could cause a redirect loop; connection failures lacked recovery. | Add an explicit setup state and retryable connection handling; keep redirect destinations local. |
| Authentication | Malformed cookies could throw; invalid/cross-site origins were inconsistently checked. | Reject malformed sessions safely and apply origin checks to mutations, including sign-in/sign-out. Require a session before starting background services or returning detailed health information. |
| Packaging | Two containers duplicated configuration; the runtime copied development dependencies/source. Local env files could enter the Docker build context. | Run the standalone web app and compiled worker under one supervisor in one container, as an unprivileged user. Exclude environment files, local data and test output from the build/runtime. |
| Startup and maintenance | Web and worker environment loading differed; initialization and worker operation were manual. | Load `.env`/`.env.local` consistently in CLI scripts, migrate and initialize automatically, supervise both processes, maintain worker heartbeats and provide a local health check. |
| Database | Simultaneous startup could race during migration discovery; failed initialization could leave a cached connection. | Serialize migration discovery/execution, add a busy timeout, and close failed connections. Provide an online SQLite backup that includes committed WAL data and refuses overwrite. |
| Dependencies | The installed framework, mailer and transitive dependencies had published audit findings. | Update dependencies and lockfile, including Next.js, React and Nodemailer; verify real MIME attachment generation with an in-memory mail transport. |
| Regression prevention | Existing tests missed the failing integration and browser paths. | Add search, identity, auth, database, worker, backup and browser regression tests, plus CI checks and an image-build check. |

## Search still depends on your Readarr metadata provider

The [Readarr retirement announcement](https://readarr.com/) states that its metadata service became unusable. Kindling can correct its own endpoint usage, identity handling and error reporting, and can search the books already present in either Readarr library. It cannot restore an unavailable upstream catalogue. Finding and adding new titles still needs a working metadata provider in each Readarr instance.

Endpoint behavior was checked against Readarr's [search controller](https://github.com/Readarr/Readarr/blob/develop/src/Readarr.Api.V1/Search/SearchController.cs), [book resource mapping](https://github.com/Readarr/Readarr/blob/develop/src/Readarr.Api.V1/Books/BookResource.cs), and [metadata identifier lookup](https://github.com/Readarr/Readarr/blob/develop/src/NzbDrone.Core/MetadataSource/BookInfo/BookInfoProxy.cs).

## Validation and practical limits

- Final verification: **120 unit/integration tests and 14 desktop/mobile browser tests passed**. Lint, TypeScript checks and the production build passed; `npm audit` reported zero vulnerabilities at the time of review.
- Unit/integration tests cover controlled Readarr responses, format routing, request retries/removal, database initialization, delivery, authentication, process supervision and SQLite backup.
- Chromium tests exercise both desktop and mobile layouts: repeat search, partial failure notices, request submission, stale-response handling, profile changes, list removal, unlock recovery and real session API checks. Screenshots were visually inspected; an encoding issue affecting development CSS was corrected.
- Lint, TypeScript checks and the production build are included in validation. The standalone package is inspected for native SQLite and mailer runtime files and for exclusion of local secrets/data.
- An isolated copy of the production runtime passed native SQLite and mailer checks, migration/profile persistence, online WAL backup, supervised web/worker startup, an HTTP 200 health check, and clean shutdown on this Windows workstation.
- Browser tests use an isolated database and controlled API responses. MIME verification uses an in-memory mail transport. No real Kindle email was sent, and no live Readarr library was modified.
- Docker Compose definitions were parsed locally. The workstation's Docker daemon was unavailable, and the user's Readarr instances were not reachable for live validation. The new GitHub CI workflow has been added but has not been run on GitHub during this review.

## Installation handover

Follow the [ZimaOS installation and migration guide](../README.md), which includes a single-container Compose setup, a ZimaOS custom-app template, persistent paths, backups, upgrades and troubleshooting. At the time of this review no image was published. Since then, every push to `main` publishes `ghcr.io/graindotpy/kindlingv2:edge` and the Zima updates from it automatically; see the README.

For the existing installation, preserve its actual data directory and SMTP configuration, stop both old containers, and back up the data before starting the replacement. After installation, verify both Readarr connections, request one ebook and one audiobook, and check Kindle delivery with the existing recipient/settings. Keep the stopped old installation and its backup until those target-machine checks succeed.

The production smoke left approximately 4.8 MB of generated runtime files in a `kindling-standalone-*` folder in the Windows user temp directory. Automatic approval review rejected cleanup without giving a specific reason. The folder contains no household data and is not part of the project or deployment.
