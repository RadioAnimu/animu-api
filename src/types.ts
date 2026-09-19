import type { FetchLike } from "./http.js";

/** Artwork size preference used when resolving a track's cover image. */
export type ArtworkQuality = "off" | "low" | "medium" | "high";
/** Which history endpoint to query. */
export type HistoryType = "requests" | "played";

/** Client platform reported to the API (labels/analytics only — never auth). */
export type ClientPlatform = "ios" | "android" | "web" | "desktop" | "other";

/**
 * Optional descriptor of the calling client. The client mirror of the
 * server-side environment detection: passed once and turned into `X-Client-*`
 * headers and a structured User-Agent (see `client-info.ts`).
 *
 * All fields are advisory and client-supplied: consumers must treat them as
 * untrusted labels, never as an authorization signal.
 */
export interface ClientInfo {
  /** Stable app id, e.g. `"animu-mobile"`. */
  app?: string;
  /** Platform bucket used for the `X-Client-Platform` header. */
  platform: ClientPlatform;
  /** App version, e.g. `"2.1.0"`. */
  version?: string;
  /** Native build number, e.g. `"12"`. */
  build?: string;
  /** OS display name, e.g. `"iOS"` / `"Android"`. */
  os?: string;
  /** OS version, e.g. `"27"` / `"17"`. */
  osVersion?: string;
  /** Human-friendly device model, e.g. `"iPhone 17 Pro Max"`. */
  model?: string;
  /** Device manufacturer, e.g. `"Apple"`. */
  manufacturer?: string;
  /** `"phone"` | `"tablet"` | `"web"` | `"unknown"`. */
  deviceType?: string;
  /** Device BCP-47 locale, e.g. `"pt-BR"`. */
  language?: string;
  /** In-app UI language tag, e.g. `"pt"`. */
  appLanguage?: string;
  /** Region/country code, e.g. `"BR"`. */
  region?: string;
  /** Whether the app runs on a simulator/emulator. */
  emulator?: boolean;
}

/** Available artwork sizes, as reported by the API. */
export interface Artworks {
  tiny?: string;
  medium?: string;
  large?: string;
}

/** A track, either now playing or from a history endpoint. */
export interface Track {
  /** Playlist track id, `"0"` when unknown, `"-1"` for history rows without one. */
  id: string;
  /** Untouched title string exactly as the API reported it. */
  raw: string;
  title: string;
  artist: string;
  /** Anime the track is associated with; falls back to a generic label. */
  anime: string;
  artworks: Artworks;
  /** Single resolved cover URL, selected by quality and validated as an image. */
  artwork: string;
  /** Duration in milliseconds. `0` when unknown (history endpoints omit it). */
  duration: number;
  /** True when the raw title marks the track as a listener request. */
  isRequest: boolean;
  /** When the track started playing. History rows may approximate this. */
  startTime: Date;
  /** Playlist the track was served from (e.g. `"Animu Toca"`); `""` when unknown. */
  playlistName: string;
}

/** The program currently on air. */
export interface Program {
  name: string;
  /** DJ currently on air; `"Haruka Yuki"` when the AutoDJ is playing. */
  dj: string;
  /** `false` while the AutoDJ ("Haruka Yuki") is on air instead of a human DJ. */
  isLive: boolean;
  imageUrl: string;
  info: string;
  theme: string;
  /** Whether the current program accepts live shout-out requests. */
  acceptingRequests: boolean;
}

/** Number of current listeners. */
export interface Listeners {
  value: number;
}

/** Result of the combined now-playing call: track + listener count. */
export interface StreamMetadata {
  /** `null` when the server payload lacks track data. */
  track: Track | null;
  listeners: Listeners;
}

/**
 * A `song_change` push from the realtime SSE stream: the same data as
 * {@link StreamMetadata} plus station identity and arrival time.
 */
export interface LiveNowPlaying {
  /** `null` when the event carried no track object. */
  track: Track | null;
  listeners: Listeners;
  /** Station display name (e.g. `"Animu FM Radio Station - ..."`). */
  serverName: string;
  /** Broadcast mode as reported by the station: `"autodj"`, `"live"` or
   * `"offline"` (station down — see `offlineSince`/`message`). */
  status: string;
  /** Untouched `rawtitle` exactly as reported. */
  rawTitle: string;
  /** Album of the on-air track, `""` when unknown. */
  album: string;
  /** RFC3339 timestamp of when the outage began; only present while `status` is `"offline"`. */
  offlineSince: string | null;
  /** Station status banner (e.g. the offline "voltamos já!" text); `null` otherwise. */
  message: string | null;
  /** When this client received the event. */
  receivedAt: Date;
}

/**
 * A single realtime event, as yielded by {@link AnimuLive.events}. Discriminated
 * by `type`.
 */
export type LiveEvent =
  | { type: "song_change"; song: LiveNowPlaying }
  | { type: "listeners"; listeners: Listeners; receivedAt: Date }
  | { type: "open" }
  | { type: "error"; error: Error }
  | { type: "close" };

/**
 * Callbacks for a realtime subscription. Every handler is optional — only
 * the events you care about need one.
 */
export interface LiveHandlers {
  /** A new track started (also carries the current listener count). */
  onSongChange?: (song: LiveNowPlaying) => void;
  /** The listener count changed (deduped: only when the value differs from
   * the previous event — `song_change` piggybacks its count too). */
  onListeners?: (listeners: Listeners, receivedAt: Date) => void;
  /** The stream connected (or reconnected) successfully. */
  onOpen?: () => void;
  /** A transport, HTTP or payload-validation error. Reconnects automatically. */
  onError?: (error: Error) => void;
  /** The subscription was closed (explicit `close()` or the client shut down). */
  onClose?: () => void;
}

/** Handle returned by {@link AnimuLive.subscribe}; call `close()` to unsubscribe. */
export interface LiveSubscription {
  /** Unsubscribes and closes the underlying connection once the last subscriber leaves. */
  close(): void;
  /** Whether this subscription has been closed. */
  readonly closed: boolean;
}

/** Constructor options for {@link AnimuLive}. All fields are optional. */
export interface LiveOptions {
  /** SSE endpoint. Defaults to {@link ENDPOINTS.live}. */
  url?: string;
  /** Sent as the `User-Agent` header. Default: `"animu-api"`. */
  userAgent?: string;
  /**
   * Optional client descriptor: derives the User-Agent (when `userAgent` is
   * absent) and merges `X-Client-*` headers into every connect/reconnect.
   */
  clientInfo?: ClientInfo;
  /** Any fetch-compatible implementation; must return a streaming response
   * body (`expo/fetch` in React Native — the global RN fetch does not stream).
   * Custom impls need no other globals: the stream does its own incremental
   * UTF-8 decoding internally (no `TextDecoder`). */
  fetchImpl?: FetchLike;
  /** Extra headers merged into every connect/reconnect request. */
  headers?: Record<string, string>;
  /** Artwork quality used when mapping the on-air track (default: `"medium"`). */
  artworkQuality?: ArtworkQuality;
  /** Cover used when the on-air track has none (default: Animu's cover). */
  defaultCover?: string;
  /** Reconnect automatically after a drop. Default: `true`. */
  reconnect?: boolean;
  /** First reconnect delay in ms; doubles per attempt. Default: `1000`. */
  minReconnectDelay?: number;
  /** Cap for the reconnect delay in ms. Default: `30000`. */
  maxReconnectDelay?: number;
  /** Random jitter fraction applied to each delay (0–1). Default: `0.2`. */
  reconnectJitter?: number;
  /**
   * Inbox (replay buffer) size: how many recent {@link LiveEvent}s the
   * shared connection retains so late subscribers drain them in order
   * before live events. Consecutive `listeners` updates coalesce to the
   * newest value. `0` disables the buffer (late subscribers only receive
   * the current state). Default: `128`.
   */
  inboxSize?: number;
  /**
   * Max events buffered per {@link AnimuLive.events} consumer while it
   * reads slower than events arrive. Beyond that, the oldest events are
   * dropped (back-to-back `listeners` updates already coalesce). Default:
   * `120`.
   */
  maxPending?: number;
}

/** An audio stream (relay) the radio publishes. */
export interface Stream {
  id: string;
  bitrate: number;
  category: string;
  url: string;
}

/** A track that can be requested on the music request panel. */
export interface MusicRequest {
  id: string;
  /** Untouched title string exactly as the API reported it. */
  raw: string;
  song: string;
  anime: string;
  artist: string;
  /** Fully-qualified artwork URL. */
  artwork: string;
  /** `false` when the track was played too recently to be requested again. */
  requestable: boolean;
}

/** Query parameters accepted by the music request search endpoint. */
export interface MusicSearchParams {
  server: number;
  filter?: string;
  query: string;
  requestable?: boolean;
  limit?: number;
  offset?: number;
}

/** One page of music request search results. */
export interface MusicRequestPagination {
  results: MusicRequest[];
  /** Parameters for the next page; pass straight back into `searchMusic`. */
  nextPageParams?: MusicSearchParams;
  totalResults: number;
  totalPages: number;
}

/** Payload for submitting a music request. */
export interface MusicRequestSubmission {
  /** Track id to request. */
  trackId: string;
  /** Message shown with the request on the panel. */
  message?: string;
  /** Authenticated PHP session id. */
  sessionId: string;
}

/** A live shout-out ("peça ao vivo") submitted while a DJ is on air. */
export interface LiveRequest {
  name: string;
  city: string;
  artist: string;
  music: string;
  anime: string;
  /** Optional message/recado. */
  request?: string;
}

/** An authenticated Animu user, resolved via the Discord OAuth2 exchange. */
export interface User {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
  avatarUrl: string;
  /** PHP session id used by authenticated endpoints. */
  sessionId: string;
  /** Whether the user has 2FA enabled on Discord (required for requests). */
  mfa: boolean;
}

/** Parameters for exchanging a Discord OAuth2 authorization code. */
export interface TokenExchangeParams {
  /** OAuth2 authorization code returned by Discord. */
  code: string;
  /** The exact redirect_uri used in the authorization request. */
  redirectUri: string;
  /** PKCE code verifier generated for the authorization request. */
  codeVerifier: string;
}

/** Constructor options for {@link AnimuApi}. All fields are optional. */
export interface AnimuApiOptions {
  /** Sent as the User-Agent header on every request. Default: `"animu-api"`. */
  userAgent?: string;
  /**
   * Optional client descriptor. When set (and `userAgent` is not), the
   * User-Agent is derived from it and `X-Client-*` headers are attached to
   * every API/SSE request. See {@link ClientInfo}.
   */
  clientInfo?: ClientInfo;
  /** Per-request timeout in ms, applied when a call doesn't override it (default: 20000). */
  timeout?: number;
  /** Fetch implementation override; defaults to the global fetch. Pass
   * `expo/fetch` in React Native for a dedicated native OkHttp stack whose
   * aborts cancel calls natively (RN's own stack can wedge when backgrounded).
   * @default globalThis.fetch */
  fetchImpl?: FetchLike;
  /** Artwork quality used when mapping tracks (default: `"medium"`). */
  artworkQuality?: ArtworkQuality;
  /** Cover used when a track has none (default: Animu's default cover). */
  defaultCover?: string;
  /** Streams returned when the stream list endpoint fails (default: Animu's public relays). */
  fallbackStreams?: Stream[];
  /**
   * Deployment base for the Animu Auth API v5 (multi-provider login + profile),
   * used by the {@link AnimuApi.auth} client. Defaults to the production deploy.
   */
  authBaseUrl?: string;
  /**
   * SSE endpoint for the realtime now-playing stream, used by the
   * {@link AnimuApi.live} client. Defaults to {@link ENDPOINTS.live}.
   */
  liveUrl?: string;
}
