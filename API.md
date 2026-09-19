# API Reference

Endpoints consumed by `animu-api`, the client method that wraps each one,
behavior at the boundary, and a usage example per method.

**Conventions**

- All track timings are **milliseconds** (epoch ms via `timestart`, durations in ms). Verified station-side: `timestart + duration` lands within ~1–3 s of the next track's start.
- Malformed payloads degrade instead of throwing whenever the server has no contract (see each endpoint).
- Every method throws `AnimuApiError` on network/HTTP failure (`statusCode: 0` for network) unless marked otherwise; client-side input problems throw `ValidationError`.

---

## Now Playing — `getStreamMetadata()`

`GET https://api.animu.moe/` → `{ track: Track | null, listeners: Listeners }`

One-shot payload (no auth). Serves the same status file the SSE stream broadcasts (see [Realtime](#realtime-stream--live)).

```jsonc
{
  "rawtitle": "TK from Ling tosite sigure - P.S. Red I | Spider-Man: Into the Spider-verse",
  "listeners": 27,
  "track": {
    "artist": "TK from Ling tosite sigure",
    "title": "P.S. Red I",            // may still carry the "| Anime" suffix
    "album": "P.S. Red I",
    "artworks": { "tiny": "…", "medium": "…", "large": "…" },
    "timestart": 1789662023000,       // epoch ms
    "duration": 256653,               // ms (string in legacy payloads, coerced)
    "playlist": { "track_id": 18213, "title": "Animu Toca" }
  }
}
```

Mapping rules:

- `parseNowPlayingTitle(rawtitle)` splits `"Artist - Title | Anime"` → `Track.{title,artist,anime}`. Server-resolved `track.artist`/`track.title` win when present; the `rawtitle` parse is the fallback.
- If the server title still embeds `" | "` (its `titleBreaker` only splits on `" - "`), the `rawtitle` parse wins so the anime suffix is not swallowed into the title.
- `Track.id` = `track.playlist.track_id` (`"0"` when absent); `Track.playlistName` = `track.playlist.title` (`""` when absent).
- `isRequest` = `rawtitle` contains `pedido` (case-insensitive).
- Listener aliases tried in order: `listeners` → `currentListeners` → `active_listeners` → `total`; invalid values clamp to `0`.
- `track` is `null` when the payload omits it.
- `startTime` = `new Date(timestart)`, falls back to `Date.now()` on `0`.
- Artwork quality chain (`high`: large→medium→tiny / `medium`: medium→tiny / `low`: tiny / `off`: default cover); the resolved URL must end in an image extension, else the default cover.

```ts
const { track, listeners } = await animu.getStreamMetadata();
console.log(track?.title, track?.anime, listeners.value);
```

---

## Current Program — `getProgram()`

`GET https://www.animu.moe/teste/locutor.php` → `Program`

Every field degrades to `""` on malformed input — never fails validation.

- `Program.isLive` is **`true`** only when `locutor` is non-empty and not the AutoDJ persona (`haruka yuki` / `haru`). Otherwise `dj` is normalized to `"Haruka Yuki"`.
- `acceptingRequests` is `true` unless `pedidos_ao_vivo === "no"` (exact match).

```ts
const p = await animu.getProgram();
p.isLive ? `ON AIR: ${p.dj}` : "AutoDJ", p.acceptingRequests;
```

---

## History — `getTrackHistory("played")` / `getTrackHistory("requests")`

`GET …/teste/ultimasmusicas_json.php` (played) · `GET …/teste/ultimospedidos_json.php` (requests) → `Track[]`

Rows are positional PHP arrays.

- played: `[rawtitle, coverUrl]`
- requests: `[rawtitle, "HH:MM:SS", requestId, coverUrl]`

Rules:

- Filler rows (jingles/idents/transitions) are dropped via `isRealTrack`: rawtitle contains `animu`, artist contains `rádio animu`, or anime contains `passagem`. Empty titles too.
- One malformed row invalidates the whole payload → `[]` (station jingle rows legitimately violate the shape).
- Rows keep payload order (newest-first); `duration: 0`, `id: "-1"` (played), `isRequest: true` on rows.
- Request timestamps are the station wall clock — São Paulo, fixed UTC-3 since 2019. Anchored to the São Paulo calendar date of `now` (a future instant ⇒ the day rolled over ⇒ the row belongs to yesterday), so display localizes correctly anywhere.

```ts
const history = await animu.getTrackHistory("played");
history[0]; // newest on-real-track entry (.title/.artist/.anime parsed from newest rawtitle)
```

---

## Music request search — `searchMusic()` / `searchMusicByTitle()`

`GET https://www.animu.moe/teste/requestSearchTest.php` → `MusicRequestPagination`

Query: `server`, `query`, `filter?`, `requestable?`, `limit?` (default 25), `offset?` (default 0). Tastypie envelope: `meta.{limit,offset,total_count,next,previous}` + `objects[]`.

- Row title format: `Artist-Title|Anime` (no spaces); without a `-` the whole segment becomes **both** artist and song (documented quirk).
- `requestable` = `!timestrike`.
- `image_*` are **relative** paths, prefixed with the web base.
- `nextPageParams` parsed from `meta.next`, reusable as `searchMusic` input; `totalPages` = `ceil(total_count / limit)`.

```ts
const page = await animu.searchMusic({ server: 1, query: "Gurenge" });
if (page.totalResults) {
  await animu.submitMusicRequest({
    trackId: page.results[0].id,    // .song/.anime/.artist/.requestable available
    message: "bora",
    sessionId,
  });
}
```

---

## Submit music request — `submitMusicRequest()`

`POST …/teste/sistemaPedidos/pedirquatro.php?mobileapp=1` (multipart: `allmusic`, `message?`, `PHPSESSID`) → `RequestResult`

- Empty body = **success**.
- `erro: false` → `PANEL_UNAVAILABLE`.
- Block keys → codes: `PEDIBLOCK` (detail = UTC datetime, `"…Z"`), `ANIBLOCK`, `ARTISTBLOCK`, `COVERBLOCK`.
- Unknown JSON → `REQUEST_ERROR`; non-JSON body echoed verbatim as the error.

Full result code set: `PEDIBLOCK`, `ANIBLOCK`, `ARTISTBLOCK`, `COVERBLOCK`, `HARUBLOCK`, `STRIKE_AND_OUT`, `ONAIR`, `BLOCOBLOCK`, `NOLOGIN`, `NO2FA`, `PANEL_UNAVAILABLE`, `REQUEST_ERROR` — business errors come back as data, never thrown.

---

## Live shout-out — `submitLiveRequest()`

`POST …/paineldj/ajaxforms(defasado)/request/salvar.php` (multipart) → `boolean`

- Client validation before any network call: `name`, `city`, `artist`, `music`, `anime` required and ≤ 100 chars; `request?` ≤ 500 chars → throws `ValidationError`.
- Response `true` iff body is `"1"`; everything else (incl. network failure) → `false`.

```ts
await animu.submitLiveRequest({ name, city, artist, music, anime, request });
```

---

## Streams — `getStreams(forceRefresh?)`

`GET https://stream.animu.moe/?json=1` → `Stream[]` (`{ id, bitrate, category, url }`)

Non-empty list is trusted and cached for the instance lifetime; failures return the fallback relays (320/192/64). `forceRefresh` bypasses both instance cache and the HTTP micro-cache.

```ts
const relays = await animu.getStreams();
player.src = relays[0].url;            // e.g. "https://stream.animu.moe/320"
```

---

## Session helpers — `validateSession()` / `logout()` / `exchangeToken()` (legacy)

- `validateSession(PHPSESSID)` `GET …/teste/chatIsThisReal.php?PHPSESSID=…` → `true` iff body `"1"`; failures return `false`.
- `logout(PHPSESSID)` `GET …/teste/byeChat.php?PHPSESSID=…` → void, best-effort, never throws.
- `exchangeToken({code, redirectUri, codeVerifier})` `POST …/teste/exchange-token.php` (urlencoded; server performs the Discord PKCE exchange) → `User` with `sessionId`. A server `error` field throws `AnimuApiError` carrying the HTTP status.

Prefer the modern `animu.auth` client ([Auth API](#auth-api-v5---animuauth)) over these.

---

## Realtime Stream (SSE) — `live`

`GET https://api.animu.moe/tungtungtung/` — `text/event-stream`, no auth.
Client: `animu.live` (`AnimuLive`), `SSEDecoder`.

Backed by the Go [`rewrite-animu-api`](https://github.com/RadioAnimu/rewrite-animu-api)
daemon: the metadata daemon polls upstream at **1 Hz**, writes a status file,
and the SSE process broadcasts every on-air change. Compared with 1 Hz API
polling (verified over a 15-minute side-by-side capture), the stream delivers
the same fields and **strictly more** fidelity: it also broadcasts
sub-second listener ticks a 1 s poller can miss.

**Events**

| Event | Payload | Meaning |
| --- | --- | --- |
| `song_change` | see below | Seeds new clients on connect; re-sent on every rawtitle change |
| `listeners` | `{ "listeners": n }` | Count change (also piggybacked inside `song_change`) |

```jsonc
// song_change
{
  "server_name": "Animu FM Radio Station - The Most Moe Radio of Brazil!",
  "status": "autodj",                 // "autodj" | "live" | "offline"
  "offline_since": "2026-09-17T18:00:00Z?",  // RFC3339, only while offline
  "message": "…",                            // station banner, only while offline
  "rawtitle": "Artist - Title | Anime",
  "listeners": 27,
  "track": { …as section 1, plus "album"; "duration" may be "notime" → coerced to 0 }
}
```

Timing semantics (verified against real traffic):

- `track.timestart` — epoch **ms**; `Track.startTime` = that instant. Station-accurate: consecutive starts land ~1–3 s apart from the previous track's stated end (upstream RadioBoss drift, not a unit bug).
- `track.duration` — **ms**. Live DJ blocks marked `[NO AR]` have no resolvable length: the daemon sends `"notime"`, which degrades to `duration: 0` ⇒ `getTrackProgress()` reports `null` (intended).
- `status`: `"autodj"` (DJ-name match), `"live"` (human DJ), `"offline"` (station down after 5 consecutive failed upstream polls → placeholder track: artist `"Rádio Animu"`, title `"Offline — Voltamos já!"`, no-cover artwork, zeroed duration/listeners, plus `offline_since` + `message`).

```ts
// Callbacks
const stop = animu.live.subscribe({
  onOpen: () => {},
  onSongChange: ({ track, listeners, status }) => console.log(track?.title, listeners.value),
  onListeners: (listeners, at) => console.log(at, listeners.value),
  onError: console.warn,    // transport / HTTP / validation — auto-reconnects
  onClose: () => {},
});
// later
stop.close();

// Ordered queue consumption
for await (const event of animu.live.events(signal)) {
  if (event.type === "song_change") render(event.song);
  if (event.type === "listeners") updateCounter(event.listeners.value);
}
```

**Inbox (ordered replay queue for clients).** One shared connection fans out to
every subscriber; it opens with the first subscriber and closes with the last —
loop in `events()` for a queue, or attach handlers. The connection retains the
last `inboxSize` events (default 128): a late/re-subscriber drains that backlog
**in order** before live events arrive. Consecutive `listeners` updates
coalesce to the newest value; past the cap the oldest events drop.
`inboxSize: 0` disables it (late subscribers only get the last known state).
Per `events()` consumer the pending queue is bounded by `maxPending` (default
120) with the same coalesce/drop policy.

Delivery guarantees:

- The server is best-effort (per-client channel of 16, silently skips slow clients) and sends no keep-alive comments; both are covered client-side by the seeding behavior + automatic reconnect with capped backoff and jitter. Non-retryable: HTTP 4xx other than 408/429.
- `song_change` is authoritative — after any gap the next event reflects current state.
- `onListeners` fires deduped (only when the value changed vs the previous event).
- Late subscribers replay the inbox synchronously, then go live; the very first event on a fresh connect is always the seeded `song_change`.
- `SSEDecoder` is exported for custom transports; `message`-type events (no `event:` field) are treated as `song_change`.
- Long-lived by design — no request timeout. Requires a streaming-capable fetch: browsers, Node ≥ 18, Deno, Bun natively; `expo/fetch` in React Native (global RN fetch can't stream bodies).

---

## Transport behavior (HTTP endpoints)

| Feature | Value |
| --- | --- |
| User-Agent | `animu-api` (configurable) |
| Timeout | 20 s per request (`AbortController`) |
| GET micro-cache | 2.5 s per URL; bypass with `noCache` / `forceRefresh` |
| JSON parsing | falls back to raw text for non-JSON bodies |
| Errors | `AnimuApiError` (`statusCode: 0` for network/timeout) |

---

# Auth API (v5) — `AnimuAuth`

The [Animu Login System](https://github.com/RadioAnimu/login-system-project)
replaces the legacy Discord flow with multi-provider OAuth (Discord, Google,
Apple, Fluxer), a passwordless **Animu Connect** email-code layer and full
profile management. `AnimuAuth` is the client for that service.

```ts
import { AnimuAuth } from "animu-api";

const auth = new AnimuAuth();                 // production deploy
// new AnimuAuth({ baseUrl: "http://localhost:8088" })
// new AnimuApi({ authBaseUrl }).auth           // via AnimuApi
```

Default `baseUrl` `https://www.animu.moe/teste/login_system_project`; requests target `<baseUrl>/api/v5/…`.

## Envelope & errors

```jsonc
{ "ok": true,  "data": { /* endpoint-specific */ } }
{ "ok": false, "error": { "code": "unauthenticated", "message": "no valid session" } }
```

Server failures throw `AnimuApiError` with `.statusCode` and `.code`; network/timeout failures have `statusCode: 0`, no code.

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `missing_params` | exchange-token missing params; `unlink` missing `provider` |
| 400 | `invalid_request` | Malformed email on code requests; extra email already set on `emails.php` POST |
| 400 | `invalid_upload` | Avatar missing/unsupported/too large |
| 400 | `link_failed` / `unlink_failed` | Link/unlink rejected |
| 401 | `token_exchange_failed` / `provider_error` | Provider rejected the code |
| 401 | `email_code_failed` | Wrong/expired Animu Connect email code, or too many attempts |
| 401 | `unauthenticated` | No valid session (also thrown client-side without token) |
| 403 | `forbidden_origin` | CSRF guard (cookie-authenticated cross-origin) |
| 404 | `unknown_provider` / `no_avatar` / `no_banner` | — |
| 404 | `not_found` | `emails.php` DELETE: no removable (extra) email with that id |
| 409 | `email_taken` | Email already belongs to another account (or yours, as a provider email) |
| 409 | `refresh_failed` | Could not refresh from the provider |
| 409 | `link_conflict` | Provider identity already belongs to another profile |
| 409 | `last_provider` | Unlinking would leave no social **provider** (the Animu Connect email is a login method, not a provider) |
| 422 | `avatar_nsfw` | Safety filter |

## Session transport

The session token is the `PHPSESSID` returned at login. Logins store it on the
client automatically; session methods accept an explicit `sessionId` override.
Sent as the `X-Session-Id` header.

```ts
auth.sessionToken;                                        // string | null
auth.setSessionToken(token);                              // rehydrate
await auth.clearSession();                                // logout + drop locals
```

Rules: sessions live 7 days (idle-expired at 7 days), the id is regenerated on
login (fixation protection). `user.verified === true` **only** when Discord is
linked **and** Discord 2FA is on — that gates the music-request queue;
Google/Apple never verify. Identity precedence: `custom user edits > Discord
(when linked) > first provider` — custom names/avatars are never overwritten.

---

## Methods

### `getProviders()` — `GET /api/v5/providers.php`

Returns `ProviderInfo[]` (`{ name, label }`); build login buttons from it — the server can add/remove providers without a client release.

### `exchangeToken(params)` — `POST /api/v5/auth/exchange-token.php` → `AuthSession { sessionToken, action, user }`

`action`: `"registered"` | `"login"`. Primary mobile login.

- `provider` (default `discord`)
- `code` — authorization code, or native Google `serverAuthCode`; required unless `identityToken`
- `identityToken` — native Apple RS256 `id_token` (alternative to `code`)
- `redirectUri` — required for every flow except native Google Sign-In
- `codeVerifier` — PKCE
- `name`/`firstName`/`lastName` — Apple `identityToken` only (Apple reports the name on first consent only)

```ts
// Native Google Sign-In (serverAuthCode): no redirectUri, no PKCE.
await auth.exchangeToken({ provider: "google", code: serverAuthCode });

// Native Sign in with Apple (RS256 id_token; verified against Apple JWKS).
await auth.exchangeToken({
  provider: "apple",
  identityToken,
  name: fullName,   // optional
});
```

### `requestEmailLoginCode(email)` — `POST /api/v5/auth/email/request.php` → `{ sent: true }`

Animu Connect: emails a single-use 4-digit login code (TTL 600 s, 5 attempts,
60 s resend cooldown). The answer is always generic — a code is only sent when
the address belongs to an account (no email enumeration). Provider emails are
auto-registered at login/link, so every Google/Apple/etc. login works here with
no extra setup.

### `verifyEmailLoginCode({ email, code })` — `POST /api/v5/auth/email/verify.php` → `AuthSession`

Verifies the code and starts a session (same response as `exchangeToken`).
Errors: `400 invalid_request` (malformed email), `401 email_code_failed`
(wrong/expired code or too many attempts).

### `getSessionStatus(sessionId?)` — `GET /api/v5/auth/session-status.php` → `{ authenticated, sessionToken }`

### `logout(sessionId?)` — `POST /api/v5/auth/logout.php` → destroys the session server-side, clears the stored token.

### `getProfile(sessionId?)` — `GET /api/v5/me/profile.php` → `AuthProfile`

`{ user, banner, linkedProviders, availableProviders, session, links }`; notable fields: `user.avatarUrl` (relative paths resolved against `baseUrl`), `banner.color` (accent fallback), `session.loginProvider` (`discord|google|fluxer|apple|animu`, `"animu"` = email-code login).

### `refreshProfile(sessionId?)` — `POST /api/v5/me/refresh.php` → `{ updated, verified, user }`

Re-fetches every linked provider and re-evaluates `verified`; also reconciles
missing provider-email Animu Connect rows.

### `getEmails(sessionId?)` — `GET /api/v5/me/emails.php` → `{ emails: AuthAccountEmail[] }`

The account's Animu Connect emails: provider emails (auto-registered,
`source: "provider"`, not removable) plus the optional extra `source: "animu"`
one — there is always **at most one** extra email.

### `requestAddEmail(email, sessionId?)` — `POST /api/v5/me/emails.php` → `{ sent: true }`

Emails a code to add the ONE extra email; refused with `400 invalid_request`
while an extra email exists (remove it first). `409 email_taken` when the
address already belongs to any account (including your own provider emails).

### `verifyAddEmail({ email, code }, sessionId?)` — `POST /api/v5/me/emails/verify.php` → `{ emails }`

Verifies the code and stores the address as the account's extra Animu Connect
email (replaced in place; at most one is guaranteed). `401 email_code_failed`,
`409 email_taken`.

### `removeEmail(emailId, sessionId?)` — `DELETE /api/v5/me/emails.php` → `{ removed, emails }`

Only the extra `source: "animu"` email is removable; provider emails answer
`404 not_found`.

### `linkProvider(params)` — `POST /api/v5/me/link.php`

Same provider params as `exchangeToken` (plus optional `user` for the Apple `form_post` callback), authenticated by session. Run the OAuth redirect yourself, then post the code.

### `unlinkProvider(provider)` — `POST /api/v5/me/unlink.php` → `{ unlinked, provider, needsSetup, linkedProviders }`

At least one social **provider** must remain — the Animu Connect email is a
login method, not a provider. `needsSetup` reaches `true` when the account lost its identity.

### Avatar / banner / account

```ts
await auth.getAvatar();        // GET  → { bytes, contentType }
await auth.uploadAvatar({ avatar, filename? }); // POST, jpeg/png/webp/gif ≤ 8 MB → URL
await auth.resetAvatar();      // DELETE → provider avatar URL
await auth.getBanner();        // banner has no upload/reset — provider-derived
await auth.deleteAccount();    // irreversible: profile, links, Animu Connect emails, sessions
```

`getAvatar` resolves custom upload → cached provider → provider CDN, streaming
raw bytes. On React Native the binary methods need `expo/fetch` (global RN
fetch lacks `arrayBuffer()`), and `uploadAvatar` wants a `Blob`/Expo `File`
(RN `{uri,type,name}` FormData isn't accepted).

### Browser flow & mobile deep link

```ts
auth.browserLoginUrl(provider?);          // …/login.php?start=<provider>
```

Browser-capable providers also support **server-driven mobile auth** via
`/mobile/<provider>-start.php` (Discord `GET`, Apple `POST form_post`): open it
in a browser session, the backend handles the OAuth redirect and bounces the
session back through the app deep link — no native SDK.

```ts
import * as WebBrowser from "expo-web-browser";

const result = await WebBrowser.openAuthSessionAsync(
  auth.mobileStartUrl("google"),  // …/mobile/google-start.php
  "animuapp://redirect",          // provider's server redirect env var
);
if (result.type === "success") {
  const parsed = auth.completeMobileAuth(result.url);
  // { ok: true, token, action, userId } — token stored; use auth as usual
}
```

Linking from inside the app: pass the current token as the second argument —

```ts
await WebBrowser.openAuthSessionAsync(auth.mobileStartUrl("apple", auth.sessionToken!), "animuapp://redirect");
```

The backend issues CSRF state + PKCE and holds the verifier server-side; state
resolves from a server-side DB table (not the session cookie), so Apple's
cross-site `form_post` and Android custom tabs still resolve. Callbacks:

```text
animuapp://redirect?token=<PHPSESSID>&action=<login|registered|linked>&user_id=<id>
animuapp://redirect?error=link_conflict|state|oauth[&msg=…]
```

---

## Legacy mobile contract

Non-enveloped endpoints taking `?PHPSESSID=`, kept for the unmodified mobile
app and pedidos scripts. Prefer v5.

| Method | Endpoint | Notes |
| --- | --- | --- |
| `legacyExchangeToken(parameters)` | `POST /mobile/exchange-token.php` | `{ user, sessionToken, action }`; `user` is `discord_data` for Discord-linked accounts, `null` otherwise. Accepts native Google `serverAuthCode` shapes. |
| `legacySessionStatus(sessionId)` | `GET /mobile/session-status.php?PHPSESSID=…` | `true` for logged-in Discord sessions. |
| `legacySessionLogout(sessionId)` | `GET /mobile/session-logout.php?PHPSESSID=…` | Destroys the session. |

Refusing error bodies (`{ error, message? }`) with HTTP 200 still throw
`AnimuApiError` carrying `error` as `.code`.

---

## Transport behavior (all endpoints)

| Feature | Value |
| --- | --- |
| User-Agent | `animu-api` (configurable) |
| Timeout | 20 s per request, `AbortController`-based |
| GET micro-cache | 2.5 s per URL; bypass with `noCache` or `forceRefresh` |
| JSON parsing | raw-text fallback for non-JSON bodies |
| Error type | `AnimuApiError` (`statusCode: 0` for network/timeout) |
