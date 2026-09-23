# crosspoint-sync

A lightweight, self-hostable sync server for [CrossPoint / CrossInk](https://github.com) e-readers —
and any KOReader device.

- **100% KOSync-compatible.** Point stock KOReader or current CrossPoint firmware at it by changing
  only the sync-server URL. Same accounts, same auth, same endpoints as `sync.koreader.rocks`.
- **Better multi-device sync.** Progress is stored per device and the newest position wins, fixing
  the ping-pong you get with stock kosync servers.
- **Server-side service connectors.** Link services such as Hardcover, Micro.blog, Audiobookshelf, and Readwise Reader once; readers continue speaking standard KOSync while the server updates external reading state.
- **Lossless CrossPoint sync.** An extended API carries the full CrossPoint position (spine,
  paragraph, anchor, page hints), not just a lossy xpath + percentage.
- **Bookmarks, clippings, and reading stats.** Delta sync with tombstones for bookmarks and
  clippings; per-device reading-stats snapshots with a server-side combined view (streaks included).
- **One codebase, one runtime.** A single Node + SQLite server in one Docker image — the hosted
  service and self-hosted installs run the exact same thing. No native dependencies (uses Node's
  built-in `node:sqlite`).

The full wire contract is in [docs/API.md](docs/API.md).

## Run it

### Docker

```sh
docker run -d --name crosspoint-sync \
  -p 8080:8080 \
  -v crosspoint-data:/data \
  ghcr.io/crosspoint-reader/crosspoint-sync:main
```

Or from a checkout: `docker compose up -d` uses the published image from
`docker-compose.yml`.

For local image builds from the checkout, use:

```sh
docker compose -f docker-compose.dev.yml up -d --build
```

### Railway (hosted-style deploy)

1. New project → Deploy from this repo (Railway detects the Dockerfile).
2. Attach a **volume** mounted at `/data`.
3. That's it — the server listens on Railway's `PORT` automatically.

### Bare Node (≥ 22.13)

```sh
npm ci && npm run build
DATABASE_PATH=./data/crosspoint.db PORT=8080 node dist/index.js
```

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `8080` | Listen port |
| `DATABASE_PATH` | `/data/crosspoint.db` | SQLite file (parent dirs auto-created) |
| `REGISTRATION_DISABLED` | `false` | Set `true` to lock down a private instance |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `30` | Per-IP limit on registration (0 disables) |
| `TOKEN_ENC_KEY` | _(unset)_ | Enables external-service connectors. 64 hex chars, a base64 32-byte key, or a ≥32-char passphrase. Encrypts stored connector credentials at rest; unset = connectors disabled. |
| `TRUST_PROXY` | `false` (`true` on Railway) | Set `true` only when direct access is blocked and a trusted reverse proxy overwrites any client-supplied `X-Forwarded-Proto`; permits connector linking through an HTTPS-terminating proxy. Defaults to `true` when `RAILWAY_ENVIRONMENT` is present, since Railway always fronts the service with its TLS-terminating edge; set `TRUST_PROXY=false` to override. |
| `CORS_ORIGINS` | `*` | Origins allowed to call the sync API from browsers (comma-separated). The default wildcard is safe: the API authenticates with headers, not cookies, and the web UI's cookie routes never get CORS headers. |
| `KINDLE_SERVER_REGISTRATION` | `false` | **Self-host, single-user installs only.** Enables a server-side Amazon device-registration endpoint for the Kindle connector (the password transits memory, never stored). Off by default; everyone else uses the browser extension below. |
| `KINDLE_SOFTWARE_REV` | `1221328936` | Kindle software revision claimed on book-content downloads (the position-ruler fetch). Should match the registration claim; modern purchases refuse delivery for old revisions. |

### Link Amazon Kindle (experimental, read-only)

Syncs reading progress **from** a non-jailbroken Kindle (or Kindle app) into crosspoint-sync, so
CrossPoint/KOReader devices resume where the Kindle left off — for Send-to-Kindle personal
documents as well as purchased books. CrossPoint → Kindle is a protocol-known but unproven write
path and is not built yet (see [docs/design/kindle-sync.md](docs/design/kindle-sync.md)).

The connector is **stealth**: it doesn't appear in the dashboard's connector list. Visit
`/kindle` on your server (e.g. `http://localhost:8080/kindle`) — the landing page has the setup
instructions and reveals it on your account page. Linking from the extension also reveals it.

The connector uses Amazon's device sync protocol with a scoped, revocable device credential —
**your Amazon password never touches the sync server**. The server *is* the registered "Android
device": it holds the credential and makes every signed sync call itself (library, positions).
Setup is the **CrossPoint Kindle Link browser extension** — download it from your own server
(`GET /kindle-link.zip`, or the download link on the dashboard's Kindle connector page), unzip,
and load unpacked at `chrome://extensions`. It is auth-only: it registers the device (password +
emailed one-time code never leave the browser) and uploads the credential — nothing else.
Purchased books need nothing at all: the server enumerates them itself. Send-to-Kindle docs are
matched manually: paste the doc's ASIN (from Manage Your Content & Devices) on the dashboard's
match page.

Freshness, without any scheduled checks: when a book syncs from a device, it's matched against
the known library; on a miss the server refreshes its purchased-book list once and retries, and a
book that still doesn't match simply doesn't sync to Kindle (the normal case for books never sent
there). The dashboard's match page has a **Refresh library** button for the
purchased-book list, and manual matching verifies a pasted ASIN against your Kindle account
(list membership plus an ownership probe) before saving it. Positions arrive as percentages
(Amazon's furthest-read model, forward-only). Fan-in is on-demand: it happens when a device asks
for progress on a matched book — no background polling of Amazon, ever.

### Link Micro.blog

1. Sign in to [Micro.blog](https://micro.blog/).
2. Open [Account → App tokens](https://micro.blog/account/apps).
3. Create a separate app token for **CrossPoint Sync**.
4. In CrossPoint Sync, open your account, choose **Micro.blog**, and paste the new token.

Treat the token like a password: Micro.blog app tokens have full account access. CrossPoint Sync
encrypts the token at rest using `TOKEN_ENC_KEY`.

## Point your reader at it

- **KOReader:** Tools → Progress sync → Custom sync server → `http://your-host:8080`
- **CrossPoint / CrossInk:** Settings → KOReader Sync → Sync Server URL

Create an account from the device (register via the sync settings), or:

```sh
curl -X POST http://localhost:8080/users/create \
  -H 'content-type: application/json' \
  -d '{"username":"justin","password":"'"$(printf '%s' 'my-password' | md5sum | cut -d' ' -f1)"'"}'
```

(The `password` field is the MD5 of your password — that's the kosync protocol; the server stores
a salted PBKDF2 of it, never the raw value.)

## Development

```sh
npm ci
npm run dev        # tsx watch, http://localhost:8080 (set DATABASE_PATH=./data/dev.db)
npm test           # vitest: kosync compat suite + v1 API suite
scripts/curl-smoke.sh http://localhost:8080   # end-to-end smoke against a running server
```

## License

MIT
