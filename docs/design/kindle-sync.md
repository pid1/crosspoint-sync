# Design: Amazon Kindle connector (Whispersync / Fiona-CDE)

Status: **read-path implemented (experimental), write-path is an unstarted live spike**.
Supersedes the Tier-3 Kindle sketch in [sync-hub.md](sync-hub.md), which targeted
`read.amazon.com` cookie-replay. That approach was abandoned for the reasons below.

## Goal

KOSync-style progress sync between CrossPoint/KOReader devices and **non-jailbroken
Kindles**, for books the user already owns as files (sent to the Kindle via
Send-to-Kindle — i.e. Amazon "personal documents" / PDOCs). The Kindle keeps speaking
to Amazon; the reader keeps speaking kosync to us; this connector bridges the two
server-side.

## Why not read.amazon.com (the old Tier-3 sketch)

The Cloud Reader internal API (what `Xetera/kindle-api` wraps) has three fatal
mismatches with this use case:

1. **Personal documents are invisible to it.** Cloud Reader's library contains only
   Amazon-store purchases (Xetera/kindle-api issue #6). Our users' books are PDOCs.
2. **No documented position write.** Reading progress is read-only there.
3. **Hostile transport.** Amazon enforces TLS fingerprinting (JA3/JA4 + HTTP/2) on its
   web surfaces since July 2023, so the server would need a browser-impersonating TLS
   stack forever, and `at-main` web cookies are a **full Amazon session** (payments
   blast radius).

## The chosen path: Fiona/CDE device protocol

Real Kindles and Kindle apps sync position through Amazon's device services:

| Host | Endpoint | Use |
|---|---|---|
| `firs-ta-g7g.amazon.com` | `POST /FirsProxy/registerDevice` | one-time device registration |
| `todo-ta-g7g.amazon.com` | `GET /FionaTodoListProxy/syncMetaData` | EBOK library metadata (validation) |
| `cde-ta-g7g.amazon.com` | `GET /FionaCDEServiceEngine/sidecar?type=T&key=ASIN` | annotation sidecar (yields GUID) |
| `cde-ta-g7g.amazon.com` | `GET /FionaCDEServiceEngine/getAnnotations?filter=last_read&type=T&key=ASIN&guid=G` | furthest-read position |
| `cde-ta-g7g.amazon.com` | `GET /FionaCDEServiceEngine/FSDownloadContent?type=T&key=ASIN` | the converted book file (position-space ruler) |

Protocol references: ptbrowne's 2020 reverse-engineering write-up + `whispersync-lib`,
`pwr/KSP` (sidecar formats), and — decisively — `svomro/kindle-whispersync-probe-snapshot`,
which **live-verified this whole read path against a physical Kindle in September 2026**,
including PDOC positions, PDOC highlight sidecars, and the MOBI7 byte-offset
interpretation of `pos`.

Properties that make this path viable for us:

- **Plain Node `fetch` works.** These are device APIs, not web pages; Amazon does not
  apply browser TLS fingerprinting to them (the probe uses stock undici with a Dalvik
  User-Agent). No native deps, no TLS-impersonation sidecar — the Docker image stays
  exactly as it is.
- **Scoped, revocable credential.** Registration returns an ADP token + RSA private key
  ("a Kindle app installation"), not a web session. It cannot purchase or manage the
  account, does not expire on a schedule, and is revoked by deregistering the device in
  Manage Your Content & Devices. Materially smaller blast radius than `at-main` cookies.
- **It covers PDOCs**, the actual books in play, for both position and (later) highlights.
- **It has a write path** (signed `POST /FionaCDEServiceEngine/sidecar` with
  `<last_read pos="…"/>` XML per KSP) — unproven, see "Write path" below.

## Security model (the "safely" part)

1. **The server never sees the user's Amazon password.** Device registration
   (email + password → Amazon emails a one-time code → replay with the code) runs in
   the **CrossPoint Kindle Link browser extension on the user's own machine**. Only the
   resulting scoped device credential (ADP token + RSA key + serial) is uploaded, over
   the existing header-authenticated API, and stored encrypted like every connector
   credential (`TOKEN_ENC_KEY`, AES-256-GCM). A self-host-only escape hatch
   (`KINDLE_SERVER_REGISTRATION=true`) enables a server-side registration endpoint for
   single-user installs where the operator is the only account holder; the password
   transits memory only and is never stored or logged. It is off by default and must
   never be enabled on the hosted multi-user service.
2. **Credential at rest = password-equivalent.** Encrypted, never logged, redacted in
   errors — same posture as the rest of the vault. The account label is the device name
   as Amazon reports it (Amazon ignores the requested "CrossPoint Sync" and assigns
   something like "Justin's Android Phone", observed 2026-09), not the user's email.
3. **Revocation is user-controlled and total:** deregistering that device in
   Amazon's Manage Your Content & Devices kills the credential; unlinking the
   connector wipes the credential, matches, and queue rows (existing framework behavior).
4. **Request discipline.** No background polling: fan-in is **on-demand only**, triggered
   when a device asks us for progress on a matched book (the same pattern as the
   BookFusion refresh). That is 2 signed GETs per refresh at human reading cadence.
   Registration is a 2-request flow performed once. Failures back off and never retry-loop
   a dead credential (401/403 → `needs_reauth`).
5. **ToS posture.** These are private endpoints; Amazon may change or block them at any
   time. The connector ships `experimental: true`, read-only, with no attempt to conceal
   what it is (it registers as a named device the user can see and remove).

## Connector shape

- `id: 'kindle'`, tier 3, `experimental`, `revealable` (stealth: absent from the
  dashboard connector list until the user visits the `/kindle` landing page — which
  carries the instructions + ToS caution and POSTs `/api/v1/connectors/kindle/reveal`
  — or links, which implies visibility). `capabilities: { read: true, write: false }`,
  `carries: ['progress']`, `credentialKind: 'token'` (the extension uploads the
  credential JSON; the dashboard's generic paste box also accepts it).
- **Credential JSON:** `{ adp_token, private_key, device_serial, device_name, library? }`
  where `library` is an optional `[{ asin, title, author, type }]` **PDOC** snapshot
  (advanced: only via a pasted credential JSON; the extension no longer captures one).
  Purchased books are not in it — the server enumerates those itself.
- **Matching:** candidates are the optional PDOC snapshot plus the server-side EBOK
  list (signed `syncMetaData`, 15-minute cache keyed by device serial). Matching is
  **on-demand**: the first time a device asks for progress on an unmatched document
  with metadata, the refresh path resolves the match right there (local scoring, no
  user action); a stale "not found" is retried only after the credential (the library
  snapshot) changes. Manual overrides via the dashboard always win: paste an ASIN
  (`PDOC:` assumed, `EBOK:` for purchases), or null for "never sync this".
  `external_id` is stored as `TYPE:ASIN`.
- **Fan-in:** `pullProgress` per matched book, on-demand via the progress-GET refresh
  (generalized from BookFusion-only to all per-book pullers; Kindle failures are
  best-effort and never fail the device's sync GET).

## Position mapping (the hard part)

`last_read.pos` is a **byte offset into the decompressed text of Amazon's converted
file**, and `last_read` is **FRL — furthest read location**, not "most recently viewed
page". Consequences:

- **Percentage, not xpath.** We convert `pos / totalDecompressedBytes` to the canonical
  0–1 fraction. `totalDecompressedBytes` comes from `FSDownloadContent` (the MOBI7 file
  Amazon serves our Android-registered identity) parsed with a minimal PalmDB/PalmDOC
  decompressor (`kindle-mobi.ts`), cached on the match's `external_edition` plus a small
  in-process LRU. Kindle Location ≈ `floor(pos/150)+1` in the same space.
- **Position spaces differ per device.** A physical Kindle reading a KF8/AZW3 delivery
  reports offsets in a *larger* space than our MOBI7 ruler (probe: 343 999 vs a
  316 153-byte MOBI7 text). When `pos` exceeds the ruler by >2% we **refuse to guess**:
  `pullProgress` throws a non-retryable `ConnectorOperationError` (logged, surfaced as
  the account's `last_error`) rather than writing a bogus 100%. The `source_device`
  attribute is logged for diagnosis. Reliable v1 mapping is for positions reported by
  Kindle apps/Android-identity devices; physical-Kindle KF8 positions need a KF8 ruler
  (register a modern-Kindle identity or Calibre-proxy mapping) — see Open questions.
- **FRL semantics.** Positions only move forward. A user re-reading an earlier chapter
  on the Kindle produces no inbound change. This is Amazon's model, not a bug; the
  design doc for merge rules ("newest wins") already tolerates it.

## Write path (the spike — NOT built)

CrossPoint → Kindle requires a signed `POST /FionaCDEServiceEngine/sidecar` with
`<annotations><book key type><last_read pos annotation_time_utc lto source_device
method="FRL" version="0"/></book></annotations>` (format from KSP's `sidecar.py`).
**Nobody has publicly live-verified a third-party position write as of Sept 2026**;
device-originated records carry an opaque `state` blob that may be required. The spike,
against a disposable document on a throwaway book, in order:

1. Read current sidecar + `last_read` (baseline).
2. POST a `<last_read>` with a small forward `pos` from our registered device.
3. GET `last_read` again — did the cloud FRL move?
4. On the physical Kindle, sync — does it offer "go to furthest page read"?
5. Probe edge behaviors: backward `pos` (must be ignored), missing `state` attr,
   `lto` semantics, rate limits.
6. Restore the original FRL if possible; document everything.

Only if steps 3–4 pass does fan-out get built (gated behind its own flag), with
forward-only semantics (`shouldPush` drops events whose percentage ≤ last known FRL).
Expected Kindle UX even in the success case: the device *prompts* to jump to the
furthest page rather than silently seeking, and PDOC sync prompts are historically
finicky. Set expectations accordingly.

## Registration flows

### Browser extension (the supported path) — `extension/`

CrossPoint Kindle Link (Chrome MV3) is **auth-only**. The server is the registered
"Android device": it holds the ADP credential and makes every signed Fiona/CDE call
itself (validation, EBOK library, sidecars, positions). The extension exists only for
the one thing that cannot leave the user's browser:

1. **Registration** — the background worker POSTs `FirsProxy/registerDevice`
   (password used for the two registration calls only, never stored), handles the
   emailed-OTP round trip, and uploads the scoped ADP credential. The server then
   owns it entirely.

It deliberately does NOT capture the MYCD personal-document list. That is only
reachable in the MYCD page's own context (Amazon's WAF challenges any other origin,
observed 2026-09), which would mean a content script on the user's Amazon tab for a
list that only saves pasting an ASIN per sideloaded doc. Send-to-Kindle docs are
matched manually instead: paste the ASIN from Manage Your Content & Devices on the
dashboard's match page (verified by the server's ownership probe).

Everything else is server-side: credential validation (`syncMetaData`), **purchased-book
(EBOK) enumeration** (signed `syncMetaData`), position pulls, and the position-space ruler.
The EBOK list is cached without expiry and refreshed **only when a match attempt misses**
(a new purchase might exist); a book that still doesn't match after the refresh simply
doesn't sync to Kindle — the normal case for books never sent there, not an error.

**Distribution:** the server serves the extension as `GET /kindle-link.zip` (built from
`extension/` at request time, cached per process; shipped in the Docker image), linked
from the dashboard's Kindle connector page alongside the load-unpacked instructions and
the experimental/ToS caution.

### Server-side (self-host only, `KINDLE_SERVER_REGISTRATION=true`)

`POST /api/v1/connectors/kindle/register/begin` `{email, password}` → Amazon emails the
code; server stashes `{email, serial}` under a 128-bit nonce in memory (10-min TTL,
per-IP attempt cap). `POST …/register/complete` `{nonce, code}` completes registration
and links the account. Password transits memory only. Off by default; do not enable on
multi-user/hosted installs.

## Live-verify checklist (before removing the experimental badge)

- [ ] Extension registration on a real account (OTP round-trip, credential validates).
- [ ] EBOK `syncMetaData` enumeration + manual PDOC ASIN match on a real account.
- [ ] `syncMetaData` validation call from the server (plain fetch, no fingerprint block).
- [ ] Sidecar GUID + `getAnnotations?filter=last_read&type=PDOC` on several real PDOCs.
- [ ] Percentage accuracy per reporting device: Kindle for Android/iOS (expected good),
  physical Kindle MOBI7 deliveries (good), physical Kindle KF8 deliveries (expect the
  >2% guard to fire — confirm it fires cleanly instead of corrupting progress).
- [ ] Echo behavior: device → Amazon → us → device, confirm no ping-pong (fan-in echo
  suppression covers the percentage path).
- [ ] Deregistration: revoke in MYCD → connector flips to `needs_reauth` on next pull.

## Open questions

- **KF8 ruler for physical-Kindle positions.** Options: register a second device identity
  with a modern-Kindle device type (does `registerDevice` accept E-ink device types from
  third parties?), or fetch a KF8 conversion another way. Until solved, physical-Kindle
  KF8 positions are skipped by the guard.
- **Library freshness.** New Amazon purchases: server-side EBOK list, refreshed on
  match-miss (no schedule); the new book auto-matches on the next progress GET for
  that document. New Send-to-Kindle docs: manual ASIN entry on the match page.
- **Highlights.** PDOC highlight/note sidecars are live-verified readable (MBP format);
  a `carries: ['highlight']` fan-in is a natural follow-up once position proves out.
- Whether `getAnnotations` has rate limits at our (very low) cadence — watch
  `last_error` in the wild.
