import * as v from "valibot";
import { ValidationError, type RequestResult } from "./errors.js";
import {
  MusicRequestResponseDTOSchema,
  ProgramDTOSchema,
  StreamMetadataDTOSchema,
  TrackHistorySchema,
  UserDTOSchema,
  type LiveListenersDTO,
  type LiveSongChangeDTO,
  type MusicRequestDTO,
  type ProgramDTO,
  type StreamMetadataDTO,
} from "./schemas.js";
import {
  DEFAULT_ANIME_FALLBACK,
  DEFAULT_COVER,
  ENDPOINTS,
} from "./endpoints.js";
import type {
  ArtworkQuality,
  Artworks,
  HistoryType,
  LiveNowPlaying,
  LiveRequest,
  Listeners,
  MusicRequest,
  MusicRequestPagination,
  MusicSearchParams,
  Program,
  Stream,
  Track,
  User,
} from "./types.js";

/** True when the URL ends with a known image extension. */
function isUrlAnImage(url: string): boolean {
  return /\.(jpeg|jpg|gif|png|webp)$/.test(url);
}

/**
 * The station's wall clock: São Paulo (America/Sao_Paulo), fixed UTC-3
 * since 2019 (Brazil abolished DST). Request-history rows are stamped
 * with bare time-of-day in this zone.
 */
const STATION_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parses the now-playing rawtitle: `"Artist - Title | Anime"`.
 *
 * Splits on `" | "` for the anime, then `" - "` for artist/title.
 * Without a dash separator the whole main segment becomes the title.
 *
 * @param rawTitle - Untouched title string from the API.
 * @param animeFallback - Anime label used when no `"| Anime"` suffix exists.
 * @returns Parsed title, artist and anime parts.
 */
export function parseNowPlayingTitle(
  rawTitle: string,
  animeFallback: string = DEFAULT_ANIME_FALLBACK,
): {
  title: string;
  artist: string;
  anime: string;
} {
  if (!rawTitle) return { title: "", artist: "", anime: animeFallback };

  let anime = animeFallback;
  const [mainPart = rawTitle, animePart] = rawTitle.split(" | ");
  if (animePart) anime = animePart.trim();

  const parts = mainPart.split(" - ");
  const titlePart = parts[1];
  if (titlePart !== undefined) {
    return {
      title: titlePart.trim(),
      artist: (parts[0] ?? "").trim(),
      anime,
    };
  }
  return { title: mainPart.trim(), artist: "", anime };
}

/**
 * Parses a request-search title: `"Artist-Title|Anime"` (no spaces —
 * this endpoint uses a different convention than the now-playing rawtitle).
 *
 * Note the API's quirk: without a `"-"` separator, the whole main segment
 * becomes **both** the artist and the song.
 *
 * @param title - Untouched title string from the search endpoint.
 * @returns Parsed song, anime and artist, with placeholder fallbacks.
 */
export function parseRequestTitle(title: string): {
  song: string;
  anime: string;
  artist: string;
} {
  const [songPart = "", animePart] = title.split("|").map((s) => s.trim());
  const [artist = "", song = ""] = songPart.split("-").map((s) => s.trim());
  return {
    song: song || songPart,
    anime: animePart || "Unknown Anime",
    artist: artist || "Unknown Artist",
  };
}

/**
 * Derives the sibling-size URLs of a cover from the station's CDN naming
 * scheme — `/media/tracks/trackImage<id>[_tiny|_medium|_large].<ext>` — so
 * a cover seen in one journey (search results, history rows) can seed the
 * dtSize another journey needs (now-playing at the user's quality, media
 * session artwork) without a new download.
 *
 * URLs that don't match the scheme (other hosts, plain `cover.jpg`,
 * suffixless base images) can't be safely rewritten — returns `null`.
 *
 * @param url - Any artwork URL, any size.
 */
export function deriveArtworkVariants(url: string): Artworks | null {
  const match =
    /^(.+\/trackImage\d+)(?:_(tiny|medium|large))?(\.[a-z0-9]+)(?:\?.*)?$/i.exec(
      url,
    );
  if (!match) return null;
  const [, base, , ext] = match;
  return {
    tiny: `${base}_tiny${ext}`,
    medium: `${base}_medium${ext}`,
    large: `${base}_large${ext}`,
  };
}

/** Size rank for cached-variant reuse: `large`/`unknown` seed everything. */
export function artworkSizeRank(url: string): "tiny" | "medium" | "large" {
  if (/_large\./.test(url)) return "large";
  if (/_tiny\./.test(url)) return "tiny";
  return "medium";
}

/**
 * Resolves a single artwork URL from the available sizes.
 *
 * Fallback chains: `high`: large→medium→tiny; `medium`: medium→tiny (never
 * large); `low`: tiny; `off`: always the default cover. URLs that don't end
 * in a known image extension are replaced by the default cover.
 *
 * @param artworks - Sizes reported by the API, if any.
 * @param quality - Requested quality preference.
 * @param defaultCover - Cover returned when nothing usable is available.
 * @returns A validated image URL.
 */
export function selectArtwork(
  artworks: Artworks | undefined,
  quality: ArtworkQuality,
  defaultCover: string = DEFAULT_COVER,
): string {
  if (!artworks) return defaultCover;
  let result: string;
  switch (quality) {
    case "high":
      result = artworks.large || artworks.medium || artworks.tiny || defaultCover;
      break;
    case "medium":
      result = artworks.medium || artworks.tiny || defaultCover;
      break;
    case "low":
      result = artworks.tiny || defaultCover;
      break;
    default:
      result = defaultCover;
  }
  return isUrlAnImage(result) ? result : defaultCover;
}

/**
 * Maps a validated now-playing metadata payload to a {@link Track}.
 *
 * The raw title is parsed into title/artist/anime; the track is flagged as a
 * request when the raw title carries the station's request marker — the
 * legacy "Pedido: …" prefix or the current "[Música pedida por …]" suffix
 * (both pedido/pedida share the "pedid" stem). A zero `timestart` falls
 * back to the current time.
 *
 * @param dto - Validated metadata DTO (see `StreamMetadataDTOSchema`).
 * @param artworkQuality - Quality preference for the resolved cover.
 * @param defaultCover - Cover used when the track has none.
 * @returns The mapped track, or `null` when the payload lacks track data.
 */
export function trackFromMetadata(
  dto: StreamMetadataDTO,
  artworkQuality: ArtworkQuality,
  defaultCover: string,
): Track | null {
  if (!dto?.track) return null;

  const raw = dto.rawtitle ?? "";
  const { title, artist, anime } = parseNowPlayingTitle(raw);
  const artwork = selectArtwork(dto.track.artworks, artworkQuality, defaultCover);

  // Prefer the server-resolved artist/title when present — but a title
  // that still embeds the "| Anime" suffix is the daemon's raw
  // titleBreaker output, in which case the rawtitle parse splits better.
  const resolvedTitle = dto.track.title?.trim();
  const serverTitle =
    resolvedTitle && !resolvedTitle.includes(" | ") ? resolvedTitle : null;

  return {
    id: dto.track.playlist?.track_id?.toString() ?? "0",
    raw,
    // The server (the Go daemon / API) resolves artist/title from its own
    // sources; the rawtitle parse is only a fallback for payloads that
    // omit them.
    title: serverTitle || title.trim(),
    artist: dto.track.artist?.trim() || artist.trim(),
    anime,
    artworks: dto.track.artworks ?? {},
    artwork,
    duration: dto.track.duration,
    startTime: new Date(dto.track.timestart || Date.now()),
    isRequest: /\bpedid[oa]/i.test(raw),
    playlistName: dto.track.playlist?.title ?? "",
  };
}

/**
 * Resolves the listener count from a metadata payload.
 *
 * The field name varies between endpoints/versions — the first known alias
 * (`listeners`, `currentListeners`, `active_listeners`, `total`) with a
 * finite, non-negative value wins. Otherwise the count is `0`.
 */
export function listenersFromMetadata(
  dto: Record<string, unknown>,
): Listeners {
  const candidates = [
    dto["listeners"],
    dto["currentListeners"],
    dto["active_listeners"],
    dto["total"],
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return { value };
  }
  return { value: 0 };
}

/**
 * Maps a validated `song_change` SSE event to a {@link LiveNowPlaying}.
 *
 * Reuses {@link trackFromMetadata} (same track shape as now-playing) and
 * {@link listenersFromMetadata}, then attaches the station name, broadcast
 * status, raw title, album and arrival time.
 *
 * @param dto - Validated `song_change` DTO.
 * @param artworkQuality - Quality preference for the resolved cover.
 * @param defaultCover - Cover used when the track has none.
 */
export function liveNowPlayingFromDTO(
  dto: LiveSongChangeDTO,
  artworkQuality: ArtworkQuality,
  defaultCover: string,
): LiveNowPlaying {
  return {
    track: trackFromMetadata(dto, artworkQuality, defaultCover),
    listeners: listenersFromMetadata(dto as unknown as Record<string, unknown>),
    serverName: dto.server_name ?? "",
    status: dto.status ?? "",
    rawTitle: dto.rawtitle ?? "",
    album: dto.track?.album ?? "",
    offlineSince: dto.offline_since ?? null,
    message: dto.message ?? null,
    receivedAt: new Date(),
  };
}

/**
 * Maps a validated `listeners` SSE event to a {@link Listeners}.
 *
 * @param dto - Validated `listeners` DTO.
 */
export function liveListenersFromDTO(dto: LiveListenersDTO): Listeners {
  return { value: dto.listeners };
}

/**
 * Maps a validated program payload to a {@link Program}.
 *
 * Business rule: the DJ is considered live only when `locutor` is non-empty
 * and not the AutoDJ persona ("Haruka Yuki"/"haru"); otherwise `dj` is
 * normalized to `"Haruka Yuki"` and `isLive` is `false`. Live requests are
 * open unless the server explicitly says `"no"`.
 */
export function programFromDTO(dto: ProgramDTO): Program {
  const locutor = dto.locutor.toLowerCase().trim();
  const isLive = !!locutor && locutor !== "haruka yuki" && locutor !== "haru";
  return {
    name: dto.programa,
    dj: isLive ? dto.locutor : "Haruka Yuki",
    isLive,
    imageUrl: dto.imagem,
    info: dto.infoPrograma,
    theme: dto.temaPrograma,
    acceptingRequests: dto.pedidos_ao_vivo !== "no",
  };
}

/**
 * Maps a history endpoint payload to tracks.
 *
 * Rows are positional PHP arrays — `[title, cover]` for played history,
 * `[title, HH:MM:SS, requestId, cover]` for requests. Rows whose title
 * contains "animu" (station jingles) are dropped; if any row fails schema
 * validation the whole payload degrades to `[]`.
 *
 * @param dto - Raw payload; validated internally.
 * @param type - Which history endpoint the payload came from.
 * @param artworkQuality - Quality preference (kept for parity; rows carry a single cover).
 * @param defaultCover - Cover used when a row has none.
 * @returns Mapped tracks; empty array for invalid payloads.
 */
export function historyFromDTO(
  dto: unknown,
  type: HistoryType,
  artworkQuality: ArtworkQuality,
  defaultCover: string,
): Track[] {
  const parsed = v.safeParse(TrackHistorySchema, dto);
  if (!parsed.success) return [];

  const isRequests = type === "requests";
  const tracks: Track[] = [];

  for (const item of parsed.output) {
    const [title] = item;
    if (!title) continue;

    const raw = title;
    const { title: song, artist, anime } = parseNowPlayingTitle(title);
    // Trailing tuple elements are loose (PHP arrays) — coerce here.
    const coverUrl = String((isRequests ? item[3] : item[1]) ?? "");

    const track: Track = {
      id: isRequests ? String(item[2] ?? "") || "-1" : "-1",
      raw,
      title: song,
      artist,
      anime,
      artworks: { tiny: coverUrl, medium: coverUrl, large: coverUrl },
      artwork: coverUrl || defaultCover,
      duration: 0,
      isRequest: true,
      startTime: getHistoryStartTime(type, isRequests ? item[1] : ""),
      playlistName: "",
    };
    // One filler rule for every panel (jingles/idents/transitions)
    if (!isRealTrack(track)) continue;

    tracks.push(track);
  }

  return tracks;
}

/**
 * Whether a mapped track is real programming instead of station filler —
 * jingles / idents / transitions. The rule is the station's (its filler
 * titles self-identify: the "animu" prefix on ids/jingles across its
 * panels, "rádio animu" now-playing ids, "passagem" transitions), so it
 * lives with the mappers and drives both history filtering and progress
 * display.
 */
export function isRealTrack(track?: Track | null): boolean {
  if (!track) return false;
  const raw = track.raw?.toLowerCase() ?? "";
  const anime = track.anime?.toLowerCase() ?? "";
  const artist = track.artist?.toLowerCase() ?? "";
  return (
    !raw.includes("animu") &&
    !anime.includes("passagem") &&
    !artist.includes("rádio animu")
  );
}

/**
 * Elapsed playback time (ms) for the track on air, or `null` when there
 * is nothing to show: track missing, not started yet, already ended, or
 * carrying invalid duration/startTime fields.
 *
 * The radio plays server-side — progress derives from the station's
 * `startTime` + `duration`, not from a local player position.
 *
 * @param track - The mapped on-air track, if any.
 * @param now - Current epoch ms (injectable for tests).
 */
export function getTrackProgress(
  track?: Track | null,
  now: number = Date.now(),
): number | null {
  if (!track) return null;

  const start = track.startTime?.getTime();
  if (start == null || !Number.isFinite(start) || start > now) return null;

  if (!Number.isFinite(track.duration) || track.duration <= 0) return null;

  const elapsed = now - start;
  if (elapsed > track.duration) return null;

  return elapsed;
}

/**
 * Start time for a history row.
 *
 * Request rows carry a bare `HH:MM:SS` in the station's wall clock
 * (America/Sao_Paulo — fixed UTC-3 since 2019, no DST). Anchoring a bare
 * time-of-day onto the DEVICE's calendar date produces a wrong absolute
 * instant anywhere else — a user in Tokyo would see the row stamped with
 * their own wall clock, and the true instant is São Paulo's. So anchor to
 * the São Paulo calendar date of `now`, then convert (UTC = São Paulo + 3h).
 * A built instant in the future means the São Paulo day rolled over since
 * the row was logged — the row belongs to yesterday.
 *
 * Everything else (played rows carry no timestamp) uses `now`.
 */
function getHistoryStartTime(
  type: HistoryType,
  timeStr: string,
  now: number = Date.now(),
): Date {
  if (type === "requests" && timeStr) {
    const [hours = 0, minutes = 0, seconds = 0] = timeStr
      .split(":")
      .map((part) => parseInt(part, 10) || 0);
    const spNow = new Date(now - STATION_UTC_OFFSET_MS);
    const epoch =
      Date.UTC(
        spNow.getUTCFullYear(),
        spNow.getUTCMonth(),
        spNow.getUTCDate(),
        hours,
        minutes,
        seconds,
      ) + STATION_UTC_OFFSET_MS;
    return new Date(epoch > now ? epoch - DAY_MS : epoch);
  }
  return new Date(now);
}

/**
 * Maps a validated search-result row to a {@link MusicRequest}.
 *
 * The row carries every image size the station has (`image_large`,
 * `image_medium`, `image_tiny`) as relative paths, prefixed with the
 * Animu web base URL. The user's artwork quality — the SAME setting that
 * selects the now-playing cover — decides which size search results
 * carry, so a song searched at `medium` and played minutes later resolves
 * to the same URL family (a disk-cache hit instead of a re-download).
 *
 * @param dto - Validated search row.
 * @param quality - Artwork quality preference; `"high"` when omitted
 *   (preserves the historical large-first behavior for callers that
 *   don't know about the setting).
 * @param defaultCover - Cover used when no image size is present.
 */
export function musicRequestFromDTO(
  dto: MusicRequestDTO,
  quality: ArtworkQuality,
  defaultCover: string,
): MusicRequest {
  const { song, anime, artist } = parseRequestTitle(dto.title);
  const artworks: Artworks = {
    tiny: dto.image_tiny ? `${ENDPOINTS.web}${dto.image_tiny}` : undefined,
    medium: dto.image_medium ? `${ENDPOINTS.web}${dto.image_medium}` : undefined,
    large: dto.image_large ? `${ENDPOINTS.web}${dto.image_large}` : undefined,
  };
  const hasAnyImage = Boolean(
    dto.image_large || dto.image_medium || dto.image_tiny,
  );
  return {
    id: dto.id.toString(),
    raw: dto.title,
    song,
    anime,
    artist: dto.author || artist,
    artwork: hasAnyImage
      ? selectArtwork(artworks, quality, defaultCover)
      : defaultCover,
    requestable: !dto.timestrike,
  };
}

/**
 * Maps a validated search response to a pagination object.
 *
 * `nextPageParams` are parsed from the server's `meta.next` URL string and
 * can be passed straight back into `searchMusic`. `totalPages` is
 * `ceil(total_count / limit)`.
 *
 * @param dto - Raw response; validated internally.
 * @param quality - Artwork quality preference for the result rows.
 * @param defaultCover - Cover used for results without artwork.
 */
export function paginationFromDTO(
  dto: unknown,
  quality: ArtworkQuality,
  defaultCover: string,
): MusicRequestPagination {
  const parsed = v.parse(MusicRequestResponseDTOSchema, dto);
  return {
    results: parsed.objects.map((o) =>
      musicRequestFromDTO(o, quality, defaultCover),
    ),
    nextPageParams: parsed.meta.next
      ? parseQueryParams(parsed.meta.next)
      : undefined,
    totalResults: parsed.meta.total_count,
    totalPages: Math.ceil(parsed.meta.total_count / parsed.meta.limit),
  };
}

/**
 * Extracts search parameters from a URL's query string, applying the
 * endpoint's documented defaults (`server: 1`, `limit: 25`, `offset: 0`;
 * `requestable` is `false` when absent).
 *
 * @param url - URL containing a query string (e.g. a `meta.next` link).
 * @throws {@link ValidationError} when the URL has no query string.
 */
export function parseQueryParams(url: string): MusicSearchParams {
  const queryString = url.split("?")[1];
  if (!queryString) throw new ValidationError("No query parameters found in URL", url);

  const params = new URLSearchParams(queryString);
  return {
    server: parseInt(params.get("server") || "1", 10),
    filter: params.get("filter") || "",
    query: params.get("query") || "",
    requestable: params.get("requestable") === "true",
    limit: parseInt(params.get("limit") || "25", 10),
    offset: parseInt(params.get("offset") || "0", 10),
  };
}

/**
 * Interprets the submission endpoint's response body as a {@link RequestResult}.
 *
 * Business rules: an empty body means success; `erro: false` (string or
 * boolean) means the panel is unavailable; the known block keys
 * (`pediblock`, `aniblock`, `artistblock`, `coverblock`) are uppercased into
 * error codes carrying the server detail; unknown JSON yields
 * `REQUEST_ERROR`; non-JSON bodies are echoed back verbatim as the error.
 *
 * @param response - Raw response text from the submission endpoint.
 */
export function parseSubmissionResponse(response: string): RequestResult {
  if (response === "") return { success: true };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(response) as Record<string, unknown>;
  } catch {
    return { success: false, error: response };
  }

  if (parsed["erro"] === "false" || parsed["erro"] === false) {
    return { success: false, error: "PANEL_UNAVAILABLE" };
  }

  const knownBlocks = ["pediblock", "aniblock", "artistblock", "coverblock"];
  for (const block of knownBlocks) {
    if (parsed[block]) {
      return {
        success: false,
        error: block.toUpperCase(),
        detail: String(parsed[block]),
      };
    }
  }

  return {
    success: false,
    error: typeof parsed["erro"] === "string" ? parsed["erro"] : "REQUEST_ERROR",
  };
}

/**
 * Maps the token-exchange endpoint's payload to a {@link User}.
 *
 * Expects `{ user: {...}, PHPSESSID }`; the session id is folded into the
 * user object before schema validation.
 *
 * @param payload - Raw exchange response, already JSON-parsed.
 * @throws A valibot error when the payload is malformed.
 */
export function userFromExchangePayload(payload: unknown): User {
  const data = payload as { user?: unknown; PHPSESSID?: string };
  const dto = { ...(data.user as object), PHPSESSID: data.PHPSESSID };
  return userFromDTO(v.parse(UserDTOSchema, dto));
}

/** Maps a validated user DTO (snake_case API fields) to a {@link User}. */
export function userFromDTO(dto: {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
  avatar_url: string;
  PHPSESSID: string;
  mfa: boolean;
}): User {
  return {
    id: dto.id,
    username: dto.username,
    nickname: dto.nickname,
    avatar: dto.avatar,
    avatarUrl: dto.avatar_url,
    sessionId: dto.PHPSESSID,
    mfa: dto.mfa,
  };
}

/** Client-side validation for a live shout-out. The server does not
 *  validate these fields, so this runs before submission. Messages are
 *  plain English codes/text — display whatever suits your project. */
export function validateLiveRequest(
  data: LiveRequest,
): { success: true } | { success: false; message: string } {
  const required: { key: keyof LiveRequest; label: string }[] = [
    { key: "name", label: "name" },
    { key: "city", label: "city" },
    { key: "artist", label: "artist" },
    { key: "music", label: "music" },
    { key: "anime", label: "anime" },
  ];

  for (const { key, label } of required) {
    const value = data[key];
    if (!value || value.trim().length === 0) {
      return { success: false, message: `${label} is required` };
    }
    if (value.length > 100) {
      return {
        success: false,
        message: `${label} must be at most 100 characters`,
      };
    }
  }

  if (data.request && data.request.length > 500) {
    return {
      success: false,
      message: "request must be at most 500 characters",
    };
  }

  return { success: true };
}
