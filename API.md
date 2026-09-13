# API Reference

HTTP endpoints used by `animu-api`, with the client method that wraps each
one and the business rules applied at the boundary. Schemas are zod
definitions exported from the package.

---

## 1. Now Playing — `getStreamMetadata()`

`GET https://api.animu.moe/`

| | |
| --- | --- |
| **Auth** | none |
| **Response** | `StreamMetadataDTOSchema` |
| **Returns** | `{ track: Track \| null, listeners: Listeners }` |
| **Errors** | `AnimuApiError`, `ValidationError` |

**Response schema**

| Field | Type | Notes |
| --- | --- | --- |
| `rawtitle` | `string?` | Server-side title, format `Artist - Title \| Anime` |
| `track.artist` | `string?` | |
| `track.title` | `string?` | |
| `track.duration` | `number` (coerced) | ms; server sends strings |
| `track.timestart` | `number` (coerced) | epoch ms; `0` falls back to `Date.now()` |
| `track.artworks.{tiny,medium,large}` | `string?` | |
| `track.playlist.track_id` | `number` (coerced) | becomes `Track.id` |
| `listeners` / `currentListeners` / `active_listeners` / `total` | `number` (coerced) | first alias present wins |

> **Business rules**
> - Listener aliases are tried in order: `listeners` → `currentListeners` → `active_listeners` → `total`. Negative/non-numeric values clamp to `0`.
> - `track` is `null` when the payload has no track object.
> - `Track.isRequest` is `true` when `rawtitle` contains `pedido` (case-insensitive).
> - Artwork is resolved by quality chain and must end in an image extension, else the default cover.

---

## 2. Current Program — `getProgram()`

`GET https://www.animu.moe/teste/locutor.php`

| | |
| --- | --- |
| **Auth** | none |
| **Response** | `ProgramDTOSchema` |
| **Returns** | `Program` |
| **Errors** | `AnimuApiError` |

**Response schema**

| Field | Type | Notes |
| --- | --- | --- |
| `locutor` | `string` | DJ name; malformed input degrades to `""` |
| `programa` | `string` | program name |
| `pedidos_ao_vivo` | `string` | `"no"` disables live requests |
| `imagem` | `string` | |
| `infoPrograma` | `string` | |
| `temaPrograma` | `string` | |

> **Business rules**
> - The DJ is **live** only when `locutor` is non-empty and not `haruka yuki` / `haru` (AutoDJ). Otherwise `dj` is normalized to `"Haruka Yuki"` and `isLive: false`.
> - `acceptingRequests` is `true` unless `pedidos_ao_vivo === "no"` (exact match).
> - Every field degrades to `""` on malformed payloads (`z.catch`) — this endpoint never fails validation.

---

## 3. Played History — `getTrackHistory("played")`

`GET https://www.animu.moe/teste/ultimasmusicas_json.php`

| | |
| --- | --- |
| **Auth** | none |
| **Response** | `TrackHistorySchema` |
| **Returns** | `Track[]` |
| **Errors** | `AnimuApiError` (invalid payloads degrade to `[]`) |

**Row schema** (positional PHP array)

| Index | Type | Meaning |
| --- | --- | --- |
| `[0]` | `string` | raw title |
| `[1]` | `string` | cover URL |

> **Business rules**
> - Filler rows are dropped via `isRealTrack` (station jingles/idents/transitions): raw title contains `animu`, artist contains `rádio animu`, or anime contains `passagem`.
> - Empty titles are dropped.
> - Rows keep payload order (newest-first); `duration` is `0`; `startTime` is now; `id` is `"-1"`; `isRequest` is `true`.
> - One malformed row invalidates the whole payload → `[]`.

---

## 4. Requests History — `getTrackHistory("requests")`

`GET https://www.animu.moe/teste/ultimospedidos_json.php`

| | |
| --- | --- |
| **Auth** | none |
| **Response** | `TrackHistorySchema` |
| **Returns** | `Track[]` |
| **Errors** | `AnimuApiError` (invalid payloads degrade to `[]`) |

**Row schema** (positional PHP array)

| Index | Type | Meaning |
| --- | --- | --- |
| `[0]` | `string` | raw title |
| `[1]` | `string` | request time, `HH:MM:SS` |
| `[2]` | `string \| number` | request id |
| `[3]` | `string` | cover URL |

> **Business rules**
> - Same row filtering as played history (`isRealTrack`).
> - `HH:MM:SS` is the station's wall clock — São Paulo (fixed UTC-3 since 2019, no DST). The mapper anchors the time to the São Paulo calendar date and converts it to an absolute epoch, so a user in any timezone sees the play time converted to *their* local time on display.
> - A built instant in the future means the São Paulo day rolled over since the row was logged → the row belongs to yesterday.
> - Missing request id → `"-1"`.

---

## 5. Music Request Search — `searchMusic()` / `searchMusicByTitle()`

`GET https://www.animu.moe/teste/requestSearchTest.php`

| | |
| --- | --- |
| **Auth** | none |
| **Query** | `server`, `query`, `filter?`, `requestable?`, `limit?`, `offset?` |
| **Response** | `MusicRequestResponseDTOSchema` |
| **Returns** | `MusicRequestPagination` |
| **Errors** | `AnimuApiError`, `ValidationError` |

**Response schema**

| Field | Type | Notes |
| --- | --- | --- |
| `meta.limit` / `meta.offset` / `meta.total_count` | `number` (coerced) | |
| `meta.next` / `meta.previous` | `string \| null` | URL of adjacent page |
| `objects[].id` | `number` (coerced) | |
| `objects[].title` | `string` | format `Artist-Title\|Anime` (no spaces) |
| `objects[].author` | `string` | degrades to `""` |
| `objects[].image_{large,medium,tiny}` | `string?` | **relative** paths |
| `objects[].timestrike` | `string?` | set when track was played recently |

> **Business rules**
> - Title parsing splits on `|` then `-`. Quirk: without a `-`, the whole segment becomes **both** artist and song.
> - `requestable` = no `timestrike` present.
> - Artwork paths are prefixed with the web base URL (which keeps its trailing slash).
> - `totalPages` = `ceil(total_count / limit)`; `nextPageParams` parsed from `meta.next` and reusable as `searchMusic` input.
> - Defaults when params are absent in `meta.next`: `server: 1`, `limit: 25`, `offset: 0`, `requestable: false`.

---

## 6. Submit Music Request — `submitMusicRequest()`

`POST https://www.animu.moe/teste/sistemaPedidos/pedirquatro.php?mobileapp=1`

| | |
| --- | --- |
| **Auth** | PHP session (`PHPSESSID` form field) |
| **Body** | `multipart/form-data`: `allmusic` (track id), `message?`, `PHPSESSID` |
| **Response** | plain text |
| **Returns** | `RequestResult` |
| **Errors** | `AnimuApiError` (network/HTTP only) |

> **Business rules**
> - `mobileapp=1` is a server-side protocol flag required by the endpoint.
> - **Empty body = success.**
> - `erro: false` (boolean or string) → `PANEL_UNAVAILABLE`.
> - Block keys `pediblock`, `aniblock`, `artistblock`, `coverblock` → uppercased codes carrying the detail. `PEDIBLOCK` detail is a UTC datetime (`+ "Z"`).
> - Unknown JSON → `REQUEST_ERROR`; non-JSON body is echoed verbatim as the error.

---

## 7. Live Request (shout-out) — `submitLiveRequest()`

`POST https://www.animu.moe/paineldj/ajaxforms(defasado)/request/salvar.php`

| | |
| --- | --- |
| **Auth** | none |
| **Body** | `multipart/form-data`: `name`, `city`, `artist`, `music`, `anime`, `request` |
| **Response** | plain text |
| **Returns** | `boolean` — `true` iff body is `"1"` |
| **Errors** | `ValidationError` (client-side, before any network call) |

> **Business rules**
> - Client-side validation: `name`, `city`, `artist`, `music`, `anime` required, max 100 chars each; `request` optional, max 500 chars.
> - Any non-`"1"` response or network failure → `false`.

---

## 8. Streams — `getStreams()`

`GET https://stream.animu.moe/?json=1`

| | |
| --- | --- |
| **Auth** | none |
| **Response** | `StreamListDTOSchema` |
| **Returns** | `Stream[]` |
| **Errors** | none — falls back to the fallback stream list |

**Response schema**

| Field | Type | Notes |
| --- | --- | --- |
| `[].id` | `string` | |
| `[].bitrate` | `number` (coerced) | |
| `[].category` | `string` | e.g. `MP3`, `AAC+` |
| `[].url` | `string` | relay URL |

> **Business rules**
> - List must be non-empty to be trusted.
> - Result is cached for the instance lifetime; failures return the fallback list (configurable).
> - `forceRefresh` bypasses both the instance cache and the HTTP micro-cache.

---

## 9. Validate Session — `validateSession()`

`GET https://www.animu.moe/teste/chatIsThisReal.php?PHPSESSID=…`

| | |
| --- | --- |
| **Auth** | PHP session (query param) |
| **Response** | plain text |
| **Returns** | `boolean` — `true` iff body is `"1"` |
| **Errors** | none — failures return `false` |

---

## 10. Logout — `logout()`

`GET https://www.animu.moe/teste/byeChat.php?PHPSESSID=…`

| | |
| --- | --- |
| **Auth** | PHP session (query param) |
| **Response** | plain text |
| **Returns** | `void` — best-effort, never throws |

---

## 11. Token Exchange — `exchangeToken()`

`POST https://www.animu.moe/teste/exchange-token.php`

| | |
| --- | --- |
| **Auth** | none (server performs the Discord PKCE exchange) |
| **Body** | `application/x-www-form-urlencoded`: `code`, `redirect_uri`, `code_verifier` |
| **Response** | `UserDTOSchema` |
| **Returns** | `User` (includes `sessionId`) |
| **Errors** | `AnimuApiError` |

**Response schema**

| Field | Type | Notes |
| --- | --- | --- |
| `user.id` / `username` / `nickname` | `string` | Discord identity |
| `user.avatar` / `avatar_url` | `string` | |
| `user.mfa` | `boolean` (coerced) | 2FA flag |
| `PHPSESSID` | `string` | folded into `User.sessionId` |

> **Business rules**
> - A server-reported `error` field becomes `AnimuApiError` carrying the HTTP status.
> - Non-JSON responses throw `AnimuApiError` (`"Exchange response is not valid JSON"`).

---

## Transport behavior (all endpoints)

| Feature | Value |
| --- | --- |
| User-Agent | `animu-api` (configurable) |
| Timeout | 20 s per request, `AbortController`-based |
| GET micro-cache | 2.5 s per URL; bypass with `noCache` or `forceRefresh` |
| JSON parsing | falls back to raw text when the body is not JSON |
| Error type | `AnimuApiError` (`statusCode: 0` for network/timeout) |

---

# Auth API (v5) — `AnimuAuth`

The [Animu Login System](https://github.com/RadioAnimu/login-system-project)
replaces the single Discord flow above with multi-provider OAuth (Discord,
Google, Apple), an optional native **Animu Connect** username/password layer
and full profile management. `AnimuAuth` is the client for that service.

```ts
import { AnimuAuth } from "animu-api";

const auth = new AnimuAuth(); // production deploy
// or: new AnimuAuth({ baseUrl: "http://localhost:8088" })
// or: new AnimuApi({ authBaseUrl }).auth
```

The default `baseUrl` is `https://www.animu.moe/teste/login_system_project`;
every request targets `<baseUrl>/api/v5/…`.

## Envelope & errors

```jsonc
// success
{ "ok": true,  "data": { /* endpoint-specific */ } }
// failure
{ "ok": false, "error": { "code": "unauthenticated", "message": "no valid session" } }
```

Server failures throw an `AnimuApiError` whose `.statusCode` is the HTTP
status and whose `.code` is the machine-readable code below (network/timeout
failures have `statusCode: 0` and no `code`).

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `missing_params` | `exchange-token`: missing `code`/`redirect_uri` |
| 400 | `invalid_upload` | Avatar missing/unsupported/too large |
| 400 | `link_failed` / `unlink_failed` | Link/unlink rejected |
| 401 | `token_exchange_failed` | Provider rejected the OAuth code |
| 401 | `provider_error` | Provider rejected the code during a link |
| 401 | `native_auth_failed` | Bad Animu Connect credentials or lockout |
| 401 | `unauthenticated` | `me/*` without a valid session (also thrown client-side when no token is set) |
| 404 | `unknown_provider` | Provider not configured |
| 404 | `no_avatar` / `no_banner` | No image available |
| 409 | `credentials_failed` | Validation, username conflict or missing current password |
| 409 | `refresh_failed` | Could not refresh from the provider |
| 409 | `link_conflict` | That provider identity belongs to another profile |
| 409 | `last_provider` | Unlinking would leave no social login |
| 422 | `avatar_nsfw` | Avatar rejected by the safety filter |

## Session transport

The session token is the `PHPSESSID` returned at login. Login methods store it
on the client automatically; every session method also accepts an explicit
`sessionId` override. It is sent as the `X-Session-Id` header.

```ts
auth.sessionToken;                       // string | null
auth.setSessionToken(token);             // rehydrate a persisted session
auth.clearSession();                     // forget it locally
```

> **Business rules**
> - Sessions live 7 days and are idle-expired after 7 days; the id is
>   regenerated on login (session fixation protection).
> - `verified === true` **only** when Discord is linked **and** 2FA is enabled
>   on Discord — this gates the pedidos music queue. Google/Apple never verify.
> - Identity ownership: `custom user edits > Discord (when linked) > first
>   provider`. Custom names/avatars are never overwritten by a provider.

## 12. Providers — `getProviders()`

`GET /api/v5/providers.php` · no auth

| | |
| --- | --- |
| **Returns** | `ProviderInfo[]` — `{ name, label }` |
| **Errors** | none |

> Build login buttons from this at runtime; the provider set can change
> server-side without a client release.

## 13. Token Exchange — `exchangeToken(params)`

`POST /api/v5/auth/exchange-token.php` · no auth (primary mobile login)

| Field | Required | Notes |
| --- | --- | --- |
| `provider` | no | defaults to `discord` |
| `code` | yes | authorization code, or the native Google `serverAuthCode` |
| `redirectUri` | no* | *required for every provider except native Google Sign-In, which omits it |
| `codeVerifier` | no | PKCE verifier (Discord/Google browser + PKCE flow) |

| | |
| --- | --- |
| **Returns** | `AuthSession` — `{ sessionToken, action, user }` |
| **Errors** | `missing_params`, `unknown_provider`, `token_exchange_failed` |

> `action` is `registered` (new account) or `login` (returning). The returned
> token is stored on the client automatically.
>
> **Native Google Sign-In (`serverAuthCode`)**: send only
> `provider: "google"` + the platform SDK's `serverAuthCode` as `code` — no
> `redirectUri`, no PKCE. The server redeems it with the **web** OAuth client
> (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`); the app's native `serverClientId`
> is that web client id.
>
> ```ts
> await auth.exchangeToken({ provider: "google", code: serverAuthCode });
> ```

## 14. Native Login — `nativeLogin(params)`

`POST /api/v5/auth/native.php` · no auth

| Field | Required |
| --- | --- |
| `username` | yes |
| `password` | yes |

| | |
| --- | --- |
| **Returns** | `AuthSession` (`action: "login"`, `user.verified` set) |
| **Errors** | `native_auth_failed` |

> There is no native signup — credentials are created from an existing account
> via `setCredentials`. After **8** failed attempts the username is locked for
> **5 minutes**.

## 15. Session Status — `getSessionStatus(sessionId?)`

`GET /api/v5/auth/session-status.php` · session optional

| | |
| --- | --- |
| **Returns** | `AuthSessionStatus` — `{ authenticated, sessionToken }` |
| **Errors** | none |

## 16. Logout — `logout(sessionId?)`

`POST /api/v5/auth/logout.php` · session required

| | |
| --- | --- |
| **Returns** | `boolean` — always `true` on success |
| **Errors** | `unauthenticated` (thrown client-side without a token) |

> Destroys the session server-side and clears the stored token.

## 17. Profile — `getProfile(sessionId?)`

`GET /api/v5/me/profile.php` · session required

| | |
| --- | --- |
| **Returns** | `AuthProfile` |
| **Errors** | `unauthenticated` |

`AuthProfile`: `{ user, banner, linkedProviders, availableProviders, session, links }`.

| Field | Type | Notes |
| --- | --- | --- |
| `user.avatarUrl` | `string \| null` | custom/cached bytes or provider CDN; relative paths resolved against `baseUrl` |
| `user.avatarCustom` | `boolean` | `true` when a custom upload is set |
| `banner.url` | `string \| null` | `me/banner.php` when cached; else `null` |
| `banner.color` | `string \| null` | Discord accent color fallback |
| `linkedProviders[]` | `{ provider, providerUserId, providerEmail }` | |
| `session.loginProvider` | `string \| null` | `discord\|google\|apple\|native` |

## 18. Refresh — `refreshProfile(sessionId?)`

`POST /api/v5/me/refresh.php` · session required

| | |
| --- | --- |
| **Returns** | `AuthRefreshResult` — `{ updated, verified, user }` |
| **Errors** | `unauthenticated`, `refresh_failed` |

> Re-fetches every linked provider (refreshing stored tokens first) and
> updates the profile + `verified`. The top-level `verified` is copied onto
> `user.verified` by the mapper (that endpoint omits it on `user`).

## 19. Credentials — `setCredentials(params, sessionId?)`

`POST /api/v5/me/credentials.php` · session required

| Field | Required | Notes |
| --- | --- | --- |
| `username` | yes | `^[a-z0-9_.-]{3,32}$` (unique, case-insensitive) |
| `password` | setup only | 8–128 chars; optional on rename |
| `currentPassword` | when credentials exist | verified against the stored hash |

| | |
| --- | --- |
| **Returns** | `AuthCredentialsResult` — `{ username, setUp }` |
| **Errors** | `unauthenticated`, `credentials_failed` |

> The username is a **login credential**, not the public display name. Changing
> the username or password always requires `currentPassword`.

## 20. Link Provider — `linkProvider(params, sessionId?)`

`POST /api/v5/me/link.php` · session required

| Field | Required | Notes |
| --- | --- | --- |
| `provider` | yes | must be configured |
| `code` | yes | authorization code, or the native Google `serverAuthCode` |
| `redirectUri` | no* | *required except for native Google Sign-In, which omits it |
| `codeVerifier` | no | PKCE verifier |
| `user` | no | Apple only: `user` JSON from the first consent callback |

| | |
| --- | --- |
| **Returns** | `AuthLinkResult` — `{ action, provider, user, linkedProviders }` |
| **Errors** | `missing_params`, `unknown_provider`, `link_failed`, `provider_error`, `link_conflict` |

> Run the provider's OAuth redirect yourself and post the code back — the same
> pattern as `exchangeToken`, but authenticated. Native Google linking accepts
> only `provider: "google"` + `serverAuthCode` (no `redirectUri`).

## 21. Unlink Provider — `unlinkProvider(provider, sessionId?)`

`POST /api/v5/me/unlink.php` · session required

| | |
| --- | --- |
| **Returns** | `AuthUnlinkResult` — `{ unlinked, provider, needsSetup, linkedProviders }` |
| **Errors** | `unlink_failed`, `last_provider` |

> At least one social provider must remain linked. `needsSetup` is `true` when
> the account lost its identity and must be rebuilt.

## 22. Avatar — `getAvatar()` / `uploadAvatar()` / `resetAvatar()`

Session required.

| Method | HTTP | Result |
| --- | --- | --- |
| `getAvatar(sessionId?)` | `GET` | `AuthImage` — `{ bytes, contentType }` (custom upload → cached provider → provider CDN) |
| `uploadAvatar({ avatar, filename? }, sessionId?)` | `POST` | `string \| null` — new avatar URL. `multipart/form-data` field `avatar`, jpeg/png/webp/gif ≤ 8 MB, re-encoded to 256 px JPEG, NSFW-checked |
| `resetAvatar(sessionId?)` | `DELETE` | `string \| null` — provider avatar URL |

| | |
| --- | --- |
| **Errors** | `unauthenticated`, `no_avatar` (GET), `invalid_upload` / `avatar_nsfw` (POST) |

> `getAvatar` streams raw bytes through `HttpClient.getBinary` (no JSON parsing).

> **React Native**: the binary methods use `Response.arrayBuffer()`, which RN's
> global `fetch` does not implement. Pass `expo/fetch` as `fetchImpl` (the JSON
> methods work with either). For `uploadAvatar`, pass a `Blob` or an
> `expo-file-system` `File`; Expo's `expo/fetch` rejects RN's `{ uri, type, name }`
> FormData part.

## 23. Banner — `getBanner(sessionId?)`

`GET /api/v5/me/banner.php` · session required

| | |
| --- | --- |
| **Returns** | `AuthImage` — `{ bytes, contentType }` |
| **Errors** | `unauthenticated`, `no_banner` |

> There is no banner upload/reset — banners are provider-derived. When no
> banner is cached, fall back to `banner.color` from `getProfile()`.

## 24. Delete Account — `deleteAccount(sessionId?)`

`DELETE /api/v5/me/account.php` · session required

| | |
| --- | --- |
| **Returns** | `boolean` — always `true` on success |
| **Errors** | `unauthenticated` |

> Permanently deletes the profile, its links, Animu Connect credentials and
> sessions (irreversible). Clears the stored token.

## Browser helper

| Method | Purpose |
| --- | --- |
| `browserLoginUrl(provider?)` | `…/login.php` or `…/login.php?start=<provider>` for the HTML flow |

## Server-side mobile Google login

Google's web OAuth client rejects custom-scheme redirect URIs, so (unlike
Discord) the app can't drive the Google redirect itself. Instead the **backend**
is the redirect target and bounces the session back over the app's deep link —
no native Google SDK, package or SHA-1 registration.

```ts
import * as WebBrowser from "expo-web-browser";

// 1. Open the backend start URL inside a browser session (custom tabs /
//    ASWebAuthenticationSession — NOT a bare WebView, Google rejects it).
const result = await WebBrowser.openAuthSessionAsync(
  auth.googleMobileStartUrl(),          // <base>/mobile/google-start.php
  "animuapp://redirect",                // GOOGLE_MOBILE_REDIRECT_URI
);
if (result.type !== "success") return;

// 2. Parse the deep link and adopt the token (returns a discriminated result).
const parsed = auth.completeMobileGoogleLogin(result.url);
if (!parsed.ok) throw new Error(`${parsed.error}${parsed.message ? `: ${parsed.message}` : ""}`);

// 3. The session token is now stored — use the profile/API as usual.
const profile = await auth.getProfile();
```

**Linking** (Account screen "add provider") uses the same flow with the current
session token — pass it to `googleMobileStartUrl(sessionId)`:

```ts
const result = await WebBrowser.openAuthSessionAsync(
  auth.googleMobileStartUrl(auth.sessionToken!), // <base>/mobile/google-start.php?sid=<token>
  "animuapp://redirect",
);
const parsed = auth.completeMobileGoogleLogin(result.url);
// parsed.action === "linked"; the token is unchanged (linking never rotates it)
```

| Method | Purpose |
| --- | --- |
| `googleMobileStartUrl(sessionId?)` | `<base>/mobile/google-start.php` (login) or `…?sid=<token>` (link). The sid must be authenticated server-side, else HTTP 401 |
| `completeMobileGoogleLogin(callbackUrl)` | Parses the deep link and, on success, adopts the token. Returns `{ ok: true, token, action, userId }` (`action` is `login`/`registered`/`linked`) or `{ ok: false, error, message }` |

The backend issues the CSRF state + PKCE and stores the verifier server-side
(the app never sees it), redirects to Google with `oauth-callback.php` as the
`redirect_uri`, then 302s:

```text
animuapp://redirect?token=<PHPSESSID>&action=<login|registered|linked>&user_id=<id>
animuapp://redirect?error=link_conflict|state|oauth[&msg=…]
```

`parseMobileGoogleRedirect(callbackUrl)` is also exported standalone. Google
links land in the same `linked_accounts` row as the web flow, so an account
merges across web and app; a Google identity already owned by another profile
yields `link_conflict`.

## Legacy mobile contract

The unmodified mobile app and the pedidos scripts use non-enveloped endpoints
that take the session as `?PHPSESSID=`. They are exposed for completeness —
prefer the v5 methods above.

| Method | Endpoint | Returns |
| --- | --- | --- |
| `legacyExchangeToken(params)` | `POST /mobile/exchange-token.php` | `LegacyMobileSession` — `{ user, sessionToken, action }`; `user` is `discord_data` (`{ username, id, avatar, mfa, avatarUrl, nickname, avatarDecorationData }`) for Discord-linked accounts, `null` otherwise |
| `legacySessionStatus(sessionId)` | `GET /mobile/session-status.php?PHPSESSID=…` | `boolean` — `true` only for a logged-in **Discord** session |
| `legacySessionLogout(sessionId)` | `GET /mobile/session-logout.php?PHPSESSID=…` | `boolean` — destroys the session, `true` when it was a Discord session |

> `legacyExchangeToken` failure bodies (`{ error, message? }`) are returned at
> HTTP 200; the client still throws an `AnimuApiError` carrying `error` as
> `.code`. It also accepts the native Google `serverAuthCode` shape (no
> `redirect_uri`). The older `AnimuApi.exchangeToken` / `validateSession` /
> `logout` methods target the original `/teste/*` legacy endpoints.
>
> The server-side mobile Google flow does **not** use `/mobile/exchange-token.php`
> — it starts at `/mobile/google-start.php` and the backend redeems the code
> itself (see above).
