# animu-api

TypeScript client for the [Animu](https://www.animu.com.br) radio API.

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
import { AnimuApi } from "animu-api";

const animu = new AnimuApi();

const { track, listeners } = await animu.getStreamMetadata();
const program = await animu.getProgram();
const played = await animu.getTrackHistory("played");
const streams = await animu.getStreams();
const page = await animu.searchMusicByTitle("attack");
```

## Configuration

All options are optional.

```ts
new AnimuApi({
  userAgent,        // "animu-api"
  timeout,          // 20_000 ms
  artworkQuality,   // "medium" — "off" | "low" | "medium" | "high"
  defaultCover,     // Animu's default cover
  fallbackStreams,  // Animu's public relays
});
```

## Errors

- `AnimuApiError` — network and HTTP failures. Inspect `.statusCode`, `.url`, `.method`.
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
| `validateSession(sessionId)` | PHP session check |
| `logout(sessionId)` | Server-side logout (best-effort) |
| `exchangeToken(params)` | Discord OAuth2 code → `User` |

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
