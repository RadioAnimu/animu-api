# animu-api

TypeScript client for the [Animu](https://www.animu.moe) radio API.

- Zero runtime dependencies. `fetch` + `zod` (peer).
- Every response validated at the boundary; malformed payloads degrade instead of throwing.
- Timeouts, GET micro-cache, uniform errors.
- ESM + CJS, tree-shakeable, fully typed.

Works on Node ≥ 18, browsers, Deno, Bun and React Native.

## Install

```bash
npm install animu-api zod
```

## Usage

```ts
import { AnimuApi, AnimuAuth } from "animu-api";

const animu = new AnimuApi();

const { track, listeners } = await animu.getStreamMetadata();
const program = await animu.getProgram();
const played = await animu.getTrackHistory("played");
const streams = await animu.getStreams();
const page = await animu.searchMusicByTitle("attack");
```

## Auth (v5)

Multi-provider OAuth (Discord, Google, Apple), Animu Connect
(username/password) and profile management via the
[Animu Login System](https://github.com/RadioAnimu/login-system-project).
Also reachable as `animu.auth`.

```ts
const auth = new AnimuAuth(); // or: new AnimuApi({ authBaseUrl }).auth

const providers = await auth.getProviders();
const { user, sessionToken } = await auth.exchangeToken({
  provider: "discord",
  code,
  redirectUri: "myapp://callback",
});
const profile = await auth.getProfile();      // reuses the stored sessionToken
await auth.setCredentials({ username: "nova_", password: "hunter2hunter2" });
const linked = await auth.linkProvider({ provider: "google", code, redirectUri });
await auth.unlinkProvider("google");
const avatar = await auth.getAvatar();        // { bytes, contentType }
await auth.logout();
```

Server failures throw `AnimuApiError` with `.statusCode` and a machine-readable
`.code` (e.g. `token_exchange_failed`, `last_provider`, `no_banner`).

Native Google Sign-In (React Native / iOS / Android) exchanges the platform
SDK's `serverAuthCode` with no `redirectUri`/PKCE:
`auth.exchangeToken({ provider: "google", code: serverAuthCode })`.

## Configuration

All options are optional.

```ts
new AnimuApi({
  userAgent,        // "animu-api"
  timeout,          // 20_000 ms
  artworkQuality,   // "medium" — "off" | "low" | "medium" | "high"
  defaultCover,     // Animu's default cover
  fallbackStreams,  // Animu's public relays
  authBaseUrl,      // Animu Auth (v5) deploy base for `api.auth`
});
```

## Errors

- `AnimuApiError` — network and HTTP failures. Inspect `.statusCode`, `.url`, `.method`, `.code`.
- `ValidationError` — payload failed schema validation, or input was rejected before any network call.

`submitMusicRequest` reports business errors as data (`RequestResult`), not throws. Codes: `PEDIBLOCK`, `ANIBLOCK`, `ARTISTBLOCK`, `COVERBLOCK`, `HARUBLOCK`, `STRIKE_AND_OUT`, `ONAIR`, `BLOCOBLOCK`, `NOLOGIN`, `NO2FA`, `PANEL_UNAVAILABLE`, `REQUEST_ERROR`.

## Methods

| Method | Purpose |
| --- | --- |
| `getStreamMetadata()` | Current track + listener count |
| `getListeners()` | Listener count |
| `getProgram()` | Current program / DJ |
| `getTrackHistory(type)` | `"played"` or `"requests"` history |
| `searchMusic(params)` | Search requestable tracks |
| `searchMusicByTitle(title)` | Search with endpoint defaults |
| `submitMusicRequest(submission)` | Submit a request (structured result) |
| `submitLiveRequest(request)` | Validate + submit a live shout-out |
| `getStreams(forceRefresh?)` | Audio streams, cached with fallback |
| `validateSession(sessionId)` | Legacy PHP session check |
| `logout(sessionId)` | Legacy server-side logout (best-effort) |
| `exchangeToken(params)` | Legacy Discord OAuth2 code → `User` |
| `auth.*` | Auth API v5 — see below |

### Auth API v5 (`AnimuAuth`)

| Method | Purpose |
| --- | --- |
| `getProviders()` | Configured login providers |
| `exchangeToken(params)` | OAuth code → session (primary mobile login) |
| `nativeLogin(params)` | Animu Connect username/password login |
| `getSessionStatus(sessionId?)` | Is the token authenticated? |
| `logout(sessionId?)` | Destroy the session |
| `getProfile(sessionId?)` | Full profile, providers, banner, session |
| `refreshProfile(sessionId?)` | Re-pull provider data + `verified` |
| `setCredentials(params, sessionId?)` | Set up / update Animu Connect |
| `linkProvider(params, sessionId?)` | Link another provider via OAuth code |
| `unlinkProvider(provider, sessionId?)` | Unlink a provider |
| `getAvatar(sessionId?)` | Avatar bytes |
| `uploadAvatar({ avatar, filename? }, sessionId?)` | Upload a custom avatar |
| `resetAvatar(sessionId?)` | Reset to the provider avatar |
| `getBanner(sessionId?)` | Banner bytes |
| `deleteAccount(sessionId?)` | Permanently delete the account |
| `browserLoginUrl(provider?)` | Browser login deep-link |
| `legacyExchangeToken(params)` | Legacy `/mobile` OAuth exchange (`discord_data`) |
| `legacySessionStatus(sessionId)` | Legacy Discord session check |
| `legacySessionLogout(sessionId)` | Legacy Discord session logout |

Full endpoint reference with request/response schemas and business rules: [API.md](API.md).

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
