import * as v from "valibot";
import { DEFAULT_COVER, DEFAULT_USER_AGENT, ENDPOINTS, FALLBACK_STREAMS } from "./endpoints.js";
import { clientHeaders, resolveUserAgent } from "./client-info.js";
import { AnimuApiError, ValidationError, type RequestResult } from "./errors.js";
import {
  errorFromResponse,
  HttpClient,
  registerInFlightController,
  toFormData,
  unregisterInFlightController,
  type FetchLike,
} from "./http.js";
import { AnimuAuth } from "./auth.js";
import { AnimuLive, readFirstSSEEvent, type SSEMessage } from "./live.js";
import type { AnimuAuthOptions } from "./auth-types.js";
import {
  historyFromDTO,
  listenersFromMetadata,
  paginationFromDTO,
  parseSubmissionResponse,
  programFromDTO,
  trackFromMetadata,
  userFromExchangePayload,
  validateLiveRequest,
} from "./mappers.js";
import {
  LiveSongChangeDTOSchema,
  MusicRequestResponseDTOSchema,
  ProgramDTOSchema,
  StreamListDTOSchema,
  type LiveSongChangeDTO,
} from "./schemas.js";
import type {
  AnimuApiOptions,
  ArtworkQuality,
  HistoryType,
  LiveRequest,
  LiveOptions,
  Listeners,
  MusicRequestPagination,
  MusicSearchParams,
  MusicRequestSubmission,
  Program,
  Stream,
  StreamMetadata,
  TokenExchangeParams,
  Track,
  User,
} from "./types.js";

/**
 * Validates a response payload against its schema, reporting failures as the
 * documented {@link ValidationError} instead of leaking valibot's raw
 * `ValiError`.
 *
 * `ValidationError` exists for exactly this ("a response payload fails schema
 * validation") and every method's JSDoc promises it, but the direct `v.parse`
 * calls let valibot's error escape: callers catching the package's single
 * error type (`AnimuApiError`) missed schema failures entirely, and the error
 * carried neither the endpoint nor the method. The valibot message is kept —
 * it names what the payload actually looked like — so the failure is still
 * diagnosable from one log line.
 */
function parsePayload<TSchema extends v.GenericSchema>(
  schema: TSchema,
  payload: unknown,
  url: string,
): v.InferOutput<TSchema> {
  try {
    return v.parse(schema, payload as v.InferInput<TSchema>);
  } catch (error) {
    const detail =
      error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new ValidationError(`Invalid response payload${detail}`, url);
  }
}

/**
 * Best-effort body of a failed response, for its error envelope. Gives up
 * (`""`) the moment `signal` aborts, so a body that stalls after its headers
 * cannot outlive the request's timeout or its caller's abort.
 */
async function errorBody(response: Response, signal: AbortSignal): Promise<string> {
  let onAbort = (): void => {};
  const aborted = new Promise<string>((resolve) => {
    onAbort = () => {
      response.body?.cancel().catch(() => {
        // already released/errored — nothing to cancel
      });
      resolve("");
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const text = (async () => {
    try {
      return await response.text();
    } catch {
      return "";
    }
  })();
  try {
    return await Promise.race([text, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Whether an SSE event carries the now-playing snapshot. */
function isSongChangeEvent(message: SSEMessage): boolean {
  return message.event === "song_change" || message.event === "message";
}

/**
 * Parses the JSON carried by a `song_change` event.
 *
 * Uses {@link LiveSongChangeDTOSchema} — the same schema the realtime client
 * validates against — so quirks like the daemon's `"notime"` duration degrade
 * exactly as they do on the long-lived stream. Both JSON syntax errors and
 * schema failures surface as {@link ValidationError}, as `getStreamMetadata`
 * documents.
 */
function parseSongChangeEvent(data: string, url: string): LiveSongChangeDTO {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch (error) {
    const detail =
      error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new ValidationError(`Invalid response payload${detail}`, url);
  }
  return parsePayload(LiveSongChangeDTOSchema, payload, url);
}

/**
 * TypeScript client for the Animu radio API.
 *
 * Covers now-playing metadata (a one-shot snapshot of the SSE stream),
 * programs, track history, music requests, live shout-outs, audio streams
 * and Discord-based authentication.
 *
 * Every response is validated at the boundary (valibot schemas) and mapped to
 * domain types. Transport features: per-request timeouts, a short-lived GET
 * micro-cache and uniform {@link AnimuApiError} error wrapping.
 *
 * All methods accept an optional per-call timeout through the underlying
 * {@link HttpClient}; construct with {@link AnimuApiOptions} to customize
 * user agent, artwork quality, default cover and fallback streams.
 *
 * @example
 * ```ts
 * const animu = new AnimuApi({ userAgent: "my-bot/1.0" });
 * // One-shot snapshot: opens the SSE stream, reads the seeding song_change,
 * // then closes the connection.
 * const { track, listeners } = await animu.getStreamMetadata();
 * ```
 */
export class AnimuApi {
  private readonly http: HttpClient;
  private readonly artworkQuality: ArtworkQuality;
  private readonly defaultCover: string;
  private readonly fallbackStreams: Stream[];
  private readonly authOptions: AnimuAuthOptions;
  private readonly liveOptions: LiveOptions;
  /** SSE endpoint used for one-shot now-playing snapshots. */
  private readonly metadataUrl: string;
  private readonly timeout: number;
  private readonly fetchImpl: FetchLike;
  /** Same User-Agent / `X-Client-*` set the HTTP client sends. */
  private readonly metadataHeaders: Record<string, string>;

  private cachedStreams: Stream[] | null = null;
  private authClient: AnimuAuth | null = null;
  private liveClient: AnimuLive | null = null;

  /** @param options - All fields optional; sensible Animu defaults are built in. */
  constructor(options: AnimuApiOptions = {}) {
    const userAgent = resolveUserAgent(
      options.userAgent,
      options.clientInfo,
      DEFAULT_USER_AGENT,
    );
    const clientInfoHeaders = clientHeaders(options.clientInfo);
    this.timeout = options.timeout ?? 20000;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.metadataUrl = options.liveUrl ?? ENDPOINTS.live;
    this.metadataHeaders = {
      "User-Agent": userAgent,
      "Content-Type": "application/json",
      ...clientInfoHeaders,
    };
    this.http = new HttpClient(
      userAgent,
      this.timeout,
      this.fetchImpl,
      clientInfoHeaders,
    );
    this.artworkQuality = options.artworkQuality ?? "medium";
    this.defaultCover = options.defaultCover ?? DEFAULT_COVER;
    this.fallbackStreams = options.fallbackStreams ?? [...FALLBACK_STREAMS];
    this.authOptions = {
      userAgent,
      clientInfo: options.clientInfo,
      timeout: options.timeout ?? 20000,
      fetchImpl: options.fetchImpl,
      baseUrl: options.authBaseUrl,
    };
    this.liveOptions = {
      userAgent,
      clientInfo: options.clientInfo,
      fetchImpl: options.fetchImpl,
      url: options.liveUrl,
      artworkQuality: options.artworkQuality ?? "medium",
      defaultCover: options.defaultCover ?? DEFAULT_COVER,
      idleTimeout: options.liveIdleTimeout,
    };
  }

  /**
   * Client for the Animu Auth API v5 (multi-provider OAuth, Animu Connect,
   * profile management). Shares this instance's user agent, timeout and fetch
   * implementation. Use `authBaseUrl` to point at a non-production deploy.
   */
  get auth(): AnimuAuth {
    this.authClient ??= new AnimuAuth(this.authOptions);
    return this.authClient;
  }

  /**
   * Realtime Server-Sent Events client for the now-playing stream
   * (`song_change` + `listeners`). Shares this instance's user agent, fetch
   * implementation, artwork quality and default cover.
   *
   * Prefer this over polling {@link getStreamMetadata} when you need live
   * updates: one long-lived connection pushes changes the moment they happen.
   * Use `liveUrl` to point at a non-production deploy.
   *
   * @example
   * ```ts
   * const stop = animu.live.subscribe({
   *   onSongChange: ({ track, listeners }) => console.log(track?.title),
   * });
   * ```
   */
  get live(): AnimuLive {
    this.liveClient ??= new AnimuLive(this.liveOptions);
    return this.liveClient;
  }

  // ─── Now playing ────────────────────────────────────────────────────────

  /**
   * Fetches the current track and listener count as a one-shot snapshot of
   * the realtime stream.
   *
   * Opens `GET` on {@link ENDPOINTS.live} (`text/event-stream`), reads until
   * the daemon's initial `song_change` event — it seeds every new connection
   * with the full current state — and then cancels the stream so the socket
   * closes. Comments and `listeners` ticks before that event are ignored, and
   * no response is cached: each call reflects the current state.
   *
   * The whole exchange (connect + first event) is bounded by the client's
   * `timeout` (default 20 s) and is cancelled by
   * {@link abortAllInFlightRequests}, like any other request, and by
   * `options.signal` until the snapshot has been read.
   *
   * @param options - `signal` aborts the whole exchange, including the wait
   * for the first event (a fetch wrapper's own signal only spans the request
   * up to its response headers).
   * @returns The mapped track (`null` when the payload lacks track data)
   * and the resolved listener count.
   * @throws {AnimuApiError} On network/HTTP failures, timeouts, or a stream
   * that ends before the first `song_change` event.
   * @throws {ValidationError} When the event payload is not valid JSON or
   * fails schema validation.
   */
  async getStreamMetadata(
    options: { signal?: AbortSignal } = {},
  ): Promise<StreamMetadata> {
    const url = this.metadataUrl;
    const controller = new AbortController();
    registerInFlightController(controller);
    // One timer covers connect + waiting for the seeding event.
    const timer = setTimeout(() => controller.abort(), this.timeout);
    // The caller's signal stays linked until the snapshot is read — unlike a
    // fetch wrapper's, which only spans the request up to its headers.
    const external = options.signal;
    const abort = (): void => controller.abort();
    if (external?.aborted) controller.abort();
    external?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.openMetadataStream(url, controller, external);
      if (!response.ok) {
        const body = await errorBody(response, controller.signal);
        if (controller.signal.aborted) {
          throw this.metadataError(null, url, controller, external);
        }
        throw errorFromResponse(response.status, body, "GET", url);
      }
      if (!response.body) {
        throw new AnimuApiError("Response has no readable body", 0, {
          method: "GET",
          url,
        });
      }

      const event = await this.readMetadataEvent(
        response.body,
        url,
        controller,
        external,
      );
      const dto = parseSongChangeEvent(event.data, url);
      return {
        track: trackFromMetadata(dto, this.artworkQuality, this.defaultCover),
        listeners: listenersFromMetadata(
          dto as unknown as Record<string, unknown>,
        ),
      };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
      // Closes the SSE socket even when the snapshot was read successfully.
      controller.abort();
      unregisterInFlightController(controller);
    }
  }

  /** Opens the SSE request, normalizing network/timeout failures. */
  private async openMetadataStream(
    url: string,
    controller: AbortController,
    external: AbortSignal | undefined,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: {
          ...this.metadataHeaders,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw this.metadataError(error, url, controller, external);
    }
  }

  /** Reads until the seeding `song_change` event, normalizing read failures. */
  private async readMetadataEvent(
    body: ReadableStream<Uint8Array>,
    url: string,
    controller: AbortController,
    external: AbortSignal | undefined,
  ): Promise<SSEMessage> {
    let event: SSEMessage | null;
    try {
      event = await readFirstSSEEvent(body, isSongChangeEvent, controller.signal);
    } catch (error) {
      throw this.metadataError(error, url, controller, external);
    }
    if (!event) {
      throw new AnimuApiError(
        "Stream ended before any song_change event",
        0,
        { method: "GET", url },
      );
    }
    return event;
  }

  /**
   * Normalizes fetch/read failures the way {@link HttpClient} does: an abort
   * (our timeout or {@link abortAllInFlightRequests}) reports the timeout
   * message, a caller's `signal` reports a cancellation, and everything else
   * keeps the underlying message.
   */
  private metadataError(
    error: unknown,
    url: string,
    controller: AbortController,
    external: AbortSignal | undefined,
  ): AnimuApiError {
    if (error instanceof AnimuApiError) return error;
    const isAbort =
      controller.signal.aborted ||
      (!!error &&
        typeof error === "object" &&
        (error as { name?: unknown }).name === "AbortError");
    let message: string;
    if (external?.aborted) {
      message = "Request aborted";
    } else if (isAbort) {
      message = `Request timed out after ${this.timeout}ms`;
    } else {
      message = error instanceof Error ? error.message : "Unknown error";
    }
    return new AnimuApiError(message, 0, { method: "GET", url });
  }

  /**
   * Fetches just the listener count.
   *
   * Convenience for {@link getStreamMetadata}; it still opens the SSE stream
   * and reads the full `song_change` snapshot.
   */
  async getListeners(): Promise<Listeners> {
    return (await this.getStreamMetadata()).listeners;
  }

  // ─── Program ────────────────────────────────────────────────────────────

  /**
   * Fetches the program currently on air.
   *
   * Malformed server fields degrade to `""` instead of failing; the AutoDJ
   * is normalized to `dj: "Haruka Yuki"` with `isLive: false`.
   *
   * @throws {AnimuApiError} On network/HTTP failures.
   */
  async getProgram(): Promise<Program> {
    const dto = parsePayload(
      ProgramDTOSchema,
      await this.http.get<unknown>(ENDPOINTS.program),
      ENDPOINTS.program,
    );
    return programFromDTO(dto);
  }

  // ─── History ────────────────────────────────────────────────────────────

  /**
   * Fetches track history from the given endpoint.
   *
   * Station filler (jingles/idents/transitions, see `isRealTrack`) is
   * filtered out; an invalid payload degrades to an empty array.
   *
   * @param type - `"played"` for the latest played tracks, `"requests"` for
   * the latest listener requests.
   * @throws {AnimuApiError} On network/HTTP failures.
   */
  async getTrackHistory(type: HistoryType): Promise<Track[]> {
    const url =
      type === "requests" ? ENDPOINTS.latestRequests : ENDPOINTS.latestPlayed;
    const dto = await this.http.get<unknown>(url);
    return historyFromDTO(dto, type, this.artworkQuality, this.defaultCover);
  }

  // ─── Music requests ─────────────────────────────────────────────────────

  /**
   * Searches the requestable-track database.
   *
   * @param params - Search parameters; reuse `nextPageParams` from a
   * previous result to walk pages.
   * @returns One page of results with pagination info.
   * @throws {AnimuApiError} On network/HTTP failures.
   * @throws {ValidationError} When the response fails schema validation.
   */
  async searchMusic(params: MusicSearchParams): Promise<MusicRequestPagination> {
    const dto = parsePayload(
      MusicRequestResponseDTOSchema,
      await this.http.get<unknown>(ENDPOINTS.requestSearch, { params: params as unknown as Record<string, string | number | boolean> }),
      ENDPOINTS.requestSearch,
    );
    return paginationFromDTO(dto, this.artworkQuality, this.defaultCover);
  }

  /**
   * Searches tracks by title using the endpoint's default parameters
   * (`server: 1`, `requestable: true`, `limit: 25`, `offset: 0`).
   *
   * @param title - Full or partial track title to search for.
   */
  async searchMusicByTitle(title: string): Promise<MusicRequestPagination> {
    return this.searchMusic({
      server: 1,
      filter: "",
      query: title,
      requestable: true,
      limit: 25,
      offset: 0,
    });
  }

  /**
   * Submits a music request using an authenticated PHP session.
   *
   * Business errors (rate limits, blocks, expired sessions) are reported in
   * the response body — they are returned as structured
   * {@link RequestResult} data rather than thrown. Use
   * {@link requestResultMessage} to render them.
   *
   * @throws {AnimuApiError} On network/HTTP failures only.
   */
  async submitMusicRequest(
    submission: MusicRequestSubmission,
  ): Promise<RequestResult> {
    // Session transport: the endpoint adopts `PHPSESSID` from the body for
    // every client, so no client-type flag is needed. Client identity now
    // travels in the `X-Client-*` headers / User-Agent instead.
    const formData = toFormData({
      allmusic: submission.trackId,
      message: submission.message,
      PHPSESSID: submission.sessionId,
    });

    const response = await this.http.post<string>(
      ENDPOINTS.requestSubmit,
      formData,
      { responseType: "text" },
    );

    return parseSubmissionResponse(response);
  }

  // ─── Live requests ──────────────────────────────────────────────────────

  /**
   * Validates and submits a live shout-out.
   *
   * The request is validated client-side first (required fields, length
   * limits) — invalid input throws before any network call.
   *
   * @returns `true` only when the server confirms with `"1"`; `false` for
   * any other response or network failure.
   * @throws {ValidationError} When the request fails validation.
   */
  async submitLiveRequest(request: LiveRequest): Promise<boolean> {
    const validation = validateLiveRequest(request);
    if (!validation.success) {
      throw new ValidationError(validation.message, ENDPOINTS.liveRequest);
    }

    const formData = toFormData({
      name: request.name,
      city: request.city,
      artist: request.artist,
      music: request.music,
      anime: request.anime,
      request: request.request ?? "",
    });

    try {
      const data = await this.http.post<string>(
        ENDPOINTS.liveRequest,
        formData,
        { responseType: "text" },
      );
      return data === "1";
    } catch {
      return false;
    }
  }

  // ─── Streams ────────────────────────────────────────────────────────────

  /**
   * Fetches the available audio streams.
   *
   * The list is cached in memory for the lifetime of this instance; an
   * unreachable or invalid endpoint degrades to the fallback stream list
   * (customizable via {@link AnimuApiOptions.fallbackStreams}) instead of
   * throwing.
   *
   * @param forceRefresh - Bypass both the instance cache and the HTTP
   * micro-cache to fetch a fresh list.
   */
  async getStreams(forceRefresh = false): Promise<Stream[]> {
    if (this.cachedStreams && !forceRefresh) {
      return this.cachedStreams;
    }

    try {
      const data = parsePayload(
        StreamListDTOSchema,
        await this.http.get<unknown>(ENDPOINTS.streams, {
          headers: { "Content-Type": "application/json" },
          noCache: forceRefresh,
        }),
        ENDPOINTS.streams,
      ).map((s) => ({
        id: s.id,
        bitrate: s.bitrate,
        category: s.category,
        url: s.url,
      }));
      this.cachedStreams = data;
    } catch {
      this.cachedStreams = [...this.fallbackStreams];
    }

    return this.cachedStreams;
  }

  /** Drops the cached stream list (and the underlying HTTP cache), forcing the next {@link getStreams} call to refetch. */
  clearStreamsCache(): void {
    this.cachedStreams = null;
    this.http.clearCache();
  }

  // ─── Auth ───────────────────────────────────────────────────────────────

  /**
   * Checks whether a PHP session id is still valid on the server.
   *
   * @returns `true` only when the server confirms with `"1"`; `false` for
   * any other response or network failure.
   */
  async validateSession(sessionId: string): Promise<boolean> {
    try {
      const data = await this.http.get<string>(ENDPOINTS.validateSession, {
        params: { PHPSESSID: sessionId },
        responseType: "text",
      });
      return data === "1";
    } catch {
      return false;
    }
  }

  /**
   * Logs the session out server-side. Best-effort — failures are swallowed
   * and the promise always resolves.
   */
  async logout(sessionId: string): Promise<void> {
    try {
      await this.http.get<string>(ENDPOINTS.logout, {
        params: { PHPSESSID: sessionId },
        responseType: "text",
      });
    } catch {
      // logout is best-effort
    }
  }

  /**
   * Exchanges a Discord OAuth2 authorization code for a validated
   * {@link User}. The PKCE exchange happens on the Animu server — your
   * client secret never touches this library.
   *
   * @param params - Code, redirect URI and PKCE verifier from your OAuth flow.
   * @returns The authenticated user, including the PHP `sessionId` used by
   * authenticated endpoints (`submitMusicRequest`, `validateSession`, `logout`).
   * @throws {AnimuApiError} On network failures, non-JSON responses or
   * server-reported OAuth errors.
   */
  async exchangeToken(params: TokenExchangeParams): Promise<User> {
    let response: Response;
    try {
      response = await fetch(ENDPOINTS.exchangeToken, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: params.code,
          redirect_uri: params.redirectUri,
          code_verifier: params.codeVerifier,
        }).toString(),
      });
    } catch {
      throw new AnimuApiError(
        "Token exchange request failed",
        0,
        { method: "POST", url: ENDPOINTS.exchangeToken },
      );
    }

    const rawText = await response.text();

    let data: unknown;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new AnimuApiError(
        "Exchange response is not valid JSON",
        response.status,
        { method: "POST", url: ENDPOINTS.exchangeToken },
      );
    }

    const payload = data as { error?: string };
    if (payload.error) {
      throw new AnimuApiError(
        `Token exchange failed: ${payload.error}`,
        response.status,
        { method: "POST", url: ENDPOINTS.exchangeToken },
      );
    }

    return userFromExchangePayload(data);
  }

  // ─── Low-level escape hatch ─────────────────────────────────────────────

  /** Raw HTTP access for endpoints not yet covered by first-class methods. */
  get raw(): HttpClient {
    return this.http;
  }
}
