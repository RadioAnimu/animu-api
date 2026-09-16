/** Canonical Animu API/service URLs used by the client. */
export const ENDPOINTS = {
  /** Animu website base URL. */
  web: "https://www.animu.moe/",
  /** Now-playing metadata API (current track + listener count). */
  api: "https://api.animu.moe/",
  /**
   * Realtime Server-Sent Events stream (`song_change` + `listeners`),
   * backed by the Go `rewrite-animu-api` SSE daemon. Long-lived — use
   * {@link AnimuLive}, never the one-shot {@link HttpClient}.
   */
  live: "https://api.animu.moe/tungtungtung/",
  /** Current program / DJ page endpoint. */
  program: "https://www.animu.moe/teste/locutor.php",
  /** Latest listener requests (positional-array JSON). */
  latestRequests:
    "https://www.animu.moe/teste/ultimospedidos_json.php",
  /** Latest played tracks (positional-array JSON). */
  latestPlayed:
    "https://www.animu.moe/teste/ultimasmusicas_json.php",
  /** Music request search endpoint. */
  requestSearch:
    "https://www.animu.moe/teste/requestSearchTest.php",
  /** Music request submission endpoint (expects multipart form data). */
  requestSubmit:
    "https://www.animu.moe/teste/sistemaPedidos/pedirquatro.php",
  /** Live shout-out submission endpoint. */
  liveRequest:
    "https://www.animu.moe/paineldj/ajaxforms(defasado)/request/salvar.php",
  /** Public stream list (`?json=1`). */
  streams: "https://stream.animu.moe/?json=1",
  /** Session validation endpoint (PHP session id check). */
  validateSession: "https://www.animu.moe/teste/chatIsThisReal.php",
  /** Server-side logout endpoint. */
  logout: "https://www.animu.moe/teste/byeChat.php",
  /** Discord OAuth2 code → Animu session exchange endpoint. */
  exchangeToken: "https://www.animu.moe/teste/exchange-token.php",
  /** Official Discord server invite. */
  discord: "https://discord.animu.moe",
  /**
   * Animu Auth API (v5) deployment base. All `/api/v5/*` and `/mobile/*`
   * paths are relative to it. Override via `AnimuAuthOptions.baseUrl`.
   */
  auth: "https://www.animu.moe/teste/login_system_project",
} as const;

/** Cover used when a track has no usable artwork. */
export const DEFAULT_COVER =
  "https://www.animu.moe/wp-content/uploads/2022/11/Animu-icon-para-OC.png";

/** Public relays returned when the stream list endpoint is unreachable. */
export const FALLBACK_STREAMS = [
  { id: "320", bitrate: 320, category: "MP3", url: "https://stream.animu.moe/320" },
  { id: "192", bitrate: 192, category: "MP3", url: "https://stream.animu.moe/192" },
  { id: "64", bitrate: 64, category: "AAC+", url: "https://stream.animu.moe/64" },
] as const;

/** Anime-name fallback used when a raw title has no `"| Anime"` suffix. */
export const DEFAULT_ANIME_FALLBACK = "Now Playing";

/** Default User-Agent header. Override via {@link AnimuApiOptions.userAgent}. */
export const DEFAULT_USER_AGENT = "animu-api";
