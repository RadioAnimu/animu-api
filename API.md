# API Reference

HTTP endpoints used by `animu-api`, with the client method that wraps each
one and the business rules applied at the boundary. Schemas are zod
definitions exported from the package.

---

## 1. Now Playing — `getStreamMetadata()`

`GET https://api.animu.com.br/`

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

`GET https://www.animu.com.br/teste/locutor.php`

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

`GET https://www.animu.com.br/teste/ultimasmusicas_json.php`

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

`GET https://www.animu.com.br/teste/ultimospedidos_json.php`

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

`GET https://www.animu.com.br/teste/requestSearchTest.php`

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

`POST https://www.animu.com.br/teste/sistemaPedidos/pedirquatro.php?mobileapp=1`

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

`POST https://www.animu.com.br/paineldj/ajaxforms(defasado)/request/salvar.php`

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

`GET https://www.animu.com.br/teste/chatIsThisReal.php?PHPSESSID=…`

| | |
| --- | --- |
| **Auth** | PHP session (query param) |
| **Response** | plain text |
| **Returns** | `boolean` — `true` iff body is `"1"` |
| **Errors** | none — failures return `false` |

---

## 10. Logout — `logout()`

`GET https://www.animu.com.br/teste/byeChat.php?PHPSESSID=…`

| | |
| --- | --- |
| **Auth** | PHP session (query param) |
| **Response** | plain text |
| **Returns** | `void` — best-effort, never throws |

---

## 11. Token Exchange — `exchangeToken()`

`POST https://www.animu.com.br/teste/exchange-token.php`

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
