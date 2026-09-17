import { DEFAULT_COVER, DEFAULT_USER_AGENT, ENDPOINTS } from "./endpoints.js";
import { AnimuApiError } from "./errors.js";
import type { FetchLike } from "./http.js";
import { liveListenersFromDTO, liveNowPlayingFromDTO } from "./mappers.js";
import {
  LiveListenersDTOSchema,
  LiveSongChangeDTOSchema,
} from "./schemas.js";
import type {
  ArtworkQuality,
  LiveEvent,
  LiveHandlers,
  LiveNowPlaying,
  LiveOptions,
  LiveSubscription,
  Listeners,
} from "./types.js";

/** A single decoded Server-Sent Event. */
export interface SSEMessage {
  /** Event name; `"message"` when the server omitted a `event:` field. */
  event: string;
  /** Concatenated `data:` payload, with the trailing newline removed. */
  data: string;
  /** Last `id:` seen, when present. */
  id?: string;
  /** Server-suggested reconnect delay in ms, when present. */
  retry?: number;
}

/**
 * Incremental Server-Sent Events parser (WHATWG spec subset).
 *
 * Feed it decoded text chunks — it tolerates events split across chunk
 * boundaries and handles `\n`, `\r\n` and `\r` line endings. Lines starting
 * with `:` (comments, used by some servers as keep-alives) are ignored, and
 * multi-line `data:` fields are joined with newlines.
 *
 * Zero-dependency and DOM-free, so it also works where `EventSource` doesn't
 * exist (Node, React Native).
 */
export class SSEDecoder {
  private buffer = "";
  private data = "";
  private eventType = "";
  private lastId: string | undefined;
  private retryValue: number | undefined;
  /** Set when a chunk ended on a lone CR so a following LF is swallowed. */
  private skipLeadingLf = false;

  /**
   * Consumes a text chunk and returns every complete event it completed.
   * Incomplete trailing lines are buffered until the next call.
   */
  push(chunk: string): SSEMessage[] {
    if (this.skipLeadingLf && chunk.startsWith("\n")) {
      chunk = chunk.slice(1);
    }
    this.skipLeadingLf = false;
    this.buffer += chunk;
    const messages: SSEMessage[] = [];
    let lineStart = 0;
    let i = 0;

    while (i < this.buffer.length) {
      const code = this.buffer.charCodeAt(i);
      let lineEnd = -1;
      let advance = 0;

      if (code === 10 /* \n */) {
        lineEnd = i;
        advance = 1;
      } else if (code === 13 /* \r */) {
        lineEnd = i;
        if (i + 1 >= this.buffer.length) {
          // CR at the buffer edge: treat it as a terminator now, and
          // swallow a leading LF if it turns out to be a split CRLF.
          this.skipLeadingLf = true;
          advance = 1;
        } else {
          advance = this.buffer.charCodeAt(i + 1) === 10 ? 2 : 1;
        }
      } else {
        i++;
        continue;
      }

      const message = this.processLine(this.buffer.slice(lineStart, lineEnd));
      if (message) messages.push(message);
      i = lineEnd + advance;
      lineStart = i;
    }

    this.buffer = this.buffer.slice(lineStart);
    return messages;
  }

  /** Resets all parser state (reconnect path). */
  reset(): void {
    this.buffer = "";
    this.data = "";
    this.eventType = "";
    this.lastId = undefined;
    this.retryValue = undefined;
    this.skipLeadingLf = false;
  }

  private processLine(line: string): SSEMessage | null {
    if (line === "") {
      if (this.data === "") {
        this.eventType = "";
        return null;
      }
      const message: SSEMessage = {
        event: this.eventType || "message",
        data: this.data.endsWith("\n")
          ? this.data.slice(0, -1)
          : this.data,
      };
      if (this.lastId !== undefined) message.id = this.lastId;
      if (this.retryValue !== undefined) message.retry = this.retryValue;
      this.data = "";
      this.eventType = "";
      return message;
    }

    if (line.startsWith(":")) return null; // comment / keep-alive

    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }

    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.data += `${value}\n`;
        break;
      case "id":
        if (!value.includes("\0")) this.lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retryValue = Number.parseInt(value, 10);
        break;
      default:
        break;
    }
    return null;
  }
}

interface Subscriber extends LiveHandlers {
  readonly id: number;
  closed: boolean;
}

/** Whether an HTTP status from a failed connect should trigger a reconnect. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Normalizes anything thrown while connecting/decoding to an {@link AnimuApiError}. */
function toLiveError(error: unknown, url: string): AnimuApiError {
  if (error instanceof AnimuApiError) return error;
  if (error instanceof SyntaxError) {
    return new AnimuApiError("Live event payload is not valid JSON", 0, {
      method: "GET",
      url,
    });
  }
  return new AnimuApiError(
    error instanceof Error ? error.message : "Live stream error",
    0,
    { method: "GET", url },
  );
}

/**
 * Incremental UTF-8 byte-sequence decoder — the `TextDecoder` replacement
 * for runtimes without it (Hermes / React Native). Buffers a lead byte's
 * continuation bytes when a multi-byte sequence splits across chunks,
 * replaces invalid bytes with U+FFFD, and never throws.
 */
class Utf8Decoder {
  /** Continuation bytes of a sequence split across the last chunk. */
  private carry: number[] = [];

  decode(bytes: Uint8Array): string {
    if (this.carry.length > 0) {
      bytes = Uint8Array.from([...this.carry, ...bytes]);
      this.carry = [];
    }

    let out = "";
    let i = 0;
    const length = bytes.length;
    while (i < length) {
      const lead = bytes[i]!;
      if (lead < 0x80) {
        out += String.fromCharCode(lead);
        i += 1;
        continue;
      }

      const size =
        lead >= 0xc2 && lead < 0xe0
          ? 2
          : lead >= 0xe0 && lead < 0xf0
            ? 3
            : lead >= 0xf0 && lead <= 0xf4
              ? 4
              : 0;
      if (
        size === 0 ||
        i + size > length
      ) {
        if (size > 0) {
          // Incomplete sequence at the end of this chunk — wait for the rest.
          this.carry = [...bytes.slice(i)];
        } else {
          out += "\u{FFFD}";
          i += 1;
        }
        return out;
      }

      let codePoint = lead & (size === 2 ? 0x1f : size === 3 ? 0x0f : 0x07);
      let valid = true;
      for (let k = 1; k < size; k += 1) {
        const byte = bytes[i + k]!;
        if ((byte & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        codePoint = (codePoint << 6) | (byte & 0x3f);
      }

      const minimum = size === 2 ? 0x80 : size === 3 ? 0x800 : 0x10000;
      if (
        !valid ||
        codePoint < minimum ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        codePoint > 0x10ffff
      ) {
        out += "\u{FFFD}";
        i += 1;
        continue;
      }

      out +=
        codePoint > 0xffff
          ? String.fromCodePoint(codePoint)
          : String.fromCharCode(codePoint);
      i += size;
    }
    return out;
  }
}

/**
 * Realtime client for Animu's Server-Sent Events stream
 * (`song_change` + `listeners`), backed by the Go `rewrite-animu-api` daemon.
 *
 * One shared connection fans out to every subscriber; it opens when the first
 * subscriber attaches and closes when the last one leaves. Drops reconnect
 * automatically with capped exponential backoff (and jitter), and late
 * subscribers immediately receive the last known song/listener state.
 *
 * The stream is long-lived, so it deliberately does NOT apply a request
 * timeout. Use a streaming-capable fetch: browsers, Node ≥ 18, Deno and Bun
 * qualify natively; in React Native pass `expo/fetch` (RN's global fetch has
 * no readable response body).
 *
 * @example
 * ```ts
 * const stop = animu.live.subscribe({
 *   onSongChange: ({ track, listeners }) => console.log(track?.title, listeners.value),
 *   onError: console.warn,
 * });
 * // later: stop.close();
 * ```
 *
 * @example Async iteration
 * ```ts
 * for await (const event of animu.live.events()) {
 *   if (event.type === "song_change") console.log(event.song.track?.title);
 * }
 * ```
 */
export class AnimuLive {
  private readonly url: string;
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Record<string, string>;
  private readonly artworkQuality: ArtworkQuality;
  private readonly defaultCover: string;
  private readonly reconnect: boolean;
  private readonly minReconnectDelay: number;
  private readonly maxReconnectDelay: number;
  private readonly reconnectJitter: number;
  private readonly inboxSize: number;
  private readonly maxPending: number;

  private readonly subscribers = new Set<Subscriber>();
  private nextSubscriberId = 1;
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveReconnect: (() => void) | null = null;
  private attempts = 0;
  private running = false;

  private currentSong: LiveNowPlaying | null = null;
  private currentListeners: { listeners: Listeners; at: Date } | null = null;

  /**
   * Shared inbox: recent `song_change`/`listeners` events, to be drained in
   * order by late subscribers. Consecutive trailing `listeners` updates
   * coalesce to a single event (they only carry the current count).
   */
  private readonly inbox: LiveEvent[] = [];

  constructor(options: LiveOptions = {}) {
    this.url = options.url ?? ENDPOINTS.live;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.headers = options.headers ?? {};
    this.artworkQuality = options.artworkQuality ?? "medium";
    this.defaultCover = options.defaultCover ?? DEFAULT_COVER;
    this.reconnect = options.reconnect ?? true;
    this.minReconnectDelay = options.minReconnectDelay ?? 1000;
    this.maxReconnectDelay = options.maxReconnectDelay ?? 30000;
    this.reconnectJitter = options.reconnectJitter ?? 0.2;
    this.inboxSize = options.inboxSize ?? 128;
    this.maxPending = options.maxPending ?? 120;
  }

  /** Whether a connection is currently open. */
  get connected(): boolean {
    return this.running && this.controller !== null;
  }

  /** Last song received (shared across subscribers); `null` until one arrives. */
  get lastSong(): LiveNowPlaying | null {
    return this.currentSong;
  }

  /** Last listener count received; `null` until one arrives. */
  get lastListeners(): Listeners | null {
    return this.currentListeners?.listeners ?? null;
  }

  /**
   * Subscribes to realtime events. The first subscriber opens the connection;
   * the last one to leave closes it. Late subscribers immediately receive the
   * last known song and listener count, if any.
   *
   * @returns A {@link LiveSubscription}; call `close()` to unsubscribe.
   */
  subscribe(handlers: LiveHandlers = {}): LiveSubscription {
    const subscriber: Subscriber = {
      ...handlers,
      id: this.nextSubscriberId++,
      closed: false,
    };
    this.subscribers.add(subscriber);
    if (!this.running) this.start();

    // Drain the inbox in order, so a late subscriber catches up on the
    // buffered events before live events reach it.
    if (this.inbox.length > 0) {
      for (const event of [...this.inbox]) {
        if (subscriber.closed) break;
        this.deliver(subscriber, event);
      }
    }

    // Fallback for late subscribers on an inbox-disabled client (`inboxSize: 0`).
    const cachedSong = this.inbox.some(
      (event) => event.type === "song_change",
    )
      ? null
      : this.currentSong;
    if (cachedSong) {
      this.safe(() => subscriber.onSongChange?.(cachedSong));
    }
    const cachedListeners = this.inbox.some((event) =>
      event.type === "listeners" || event.type === "song_change",
    )
      ? null
      : this.currentListeners;
    if (cachedListeners) {
      this.safe(() =>
        subscriber.onListeners?.(cachedListeners.listeners, cachedListeners.at),
      );
    }

    return {
      close: () => {
        if (subscriber.closed) return;
        subscriber.closed = true;
        this.subscribers.delete(subscriber);
        this.safe(() => subscriber.onClose?.());
        if (this.subscribers.size === 0) this.stop();
      },
      get closed() {
        return subscriber.closed;
      },
    };
  }

  /**
   * Async-iterates realtime events until the optional `signal` aborts or the
   * consumer breaks out of the loop. Reconnects transparently, emitting an
   * `open` event after each (re)connect and an `error` event on failures.
   */
  async *events(signal?: AbortSignal): AsyncGenerator<LiveEvent, void, void> {
    const queue: LiveEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let finished = false;

    const enqueue = (event: LiveEvent): void => {
      // Coalesce consecutive listener-count updates: a slow consumer cares
      // about the newest value, not every intermediate one.
      if (
        event.type === "listeners" &&
        queue[queue.length - 1]?.type === "listeners"
      ) {
        queue[queue.length - 1] = event;
      } else {
        queue.push(event);
      }
      // Bound the pending backlog: drop the oldest events past the cap.
      while (queue.length > this.maxPending) queue.shift();
      const resolve = resolveNext;
      resolveNext = null;
      resolve?.();
    };

    const subscription = this.subscribe({
      onSongChange: (song) => enqueue({ type: "song_change", song }),
      onListeners: (listeners, receivedAt) =>
        enqueue({ type: "listeners", listeners, receivedAt }),
      onOpen: () => enqueue({ type: "open" }),
      onError: (error) => enqueue({ type: "error", error }),
      onClose: () => {
        finished = true;
        const resolve = resolveNext;
        resolveNext = null;
        resolve?.();
      },
    });

    const onAbort = (): void => subscription.close();
    signal?.addEventListener("abort", onAbort);

    try {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      subscription.close();
    }
  }

  /**
   * Stops the stream and closes every subscription. The client can be reused:
   * the next {@link subscribe} call reconnects.
   */
  close(): void {
    this.stop();
  }

  // ── Connection lifecycle ────────────────────────────────────────────────

  private start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  private async run(): Promise<void> {
    while (this.running) {
      const controller = new AbortController();
      this.controller = controller;
      let retryable = true;
      let endedCleanly = false;

      try {
        const response = await this.fetchImpl(this.url, {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            "User-Agent": this.userAgent,
            ...this.headers,
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          retryable = isRetryableStatus(response.status);
          throw new AnimuApiError(
            `Live stream failed with HTTP ${response.status}`,
            response.status,
            { method: "GET", url: this.url },
          );
        }
        if (!response.body) {
          throw new AnimuApiError(
            "Live stream response has no readable body",
            0,
            { method: "GET", url: this.url },
          );
        }

        this.attempts = 0;
        this.emitOpen();
        await this.consume(response.body, controller.signal);
        endedCleanly = this.running && !controller.signal.aborted;
      } catch (error) {
        if (!this.running || controller.signal.aborted) break;
        this.emitError(toLiveError(error, this.url));
      } finally {
        if (this.controller === controller) this.controller = null;
      }

      if (!this.running) break;
      if (endedCleanly) {
        this.emitError(
          new AnimuApiError("Live stream ended", 0, {
            method: "GET",
            url: this.url,
          }),
        );
      }
      if (!this.reconnect || !retryable) break;
      await this.waitBackoff();
    }
    // Terminal exit (reconnect disabled or non-retryable status): release the
    // subscribers so late subscribers start a fresh connection.
    this.stop();
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    // Incremental UTF-8 decode — no TextDecoder needed (Hermes-safe).
    const utf8 = new Utf8Decoder();
    const sse = new SSEDecoder();
    try {
      while (this.running && !signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of sse.push(utf8.decode(value))) {
          this.dispatch(message);
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // reader already released/errored — nothing to clean up
      }
    }
  }

  private dispatch(message: SSEMessage): void {
    if (message.event === "song_change" || message.event === "message") {
      let dto;
      try {
        dto = LiveSongChangeDTOSchema.parse(JSON.parse(message.data));
      } catch (error) {
        this.emitError(toLiveError(error, this.url));
        return;
      }
      const song = liveNowPlayingFromDTO(
        dto,
        this.artworkQuality,
        this.defaultCover,
      );
      this.currentSong = song;
      this.bufferEvent({ type: "song_change", song });

      const previous = this.currentListeners?.listeners.value;
      this.currentListeners = { listeners: song.listeners, at: song.receivedAt };
      for (const subscriber of this.subscribers) {
        this.safe(() => subscriber.onSongChange?.(song));
        if (previous !== song.listeners.value) {
          this.safe(() => subscriber.onListeners?.(song.listeners, song.receivedAt));
        }
      }
      return;
    }

    if (message.event === "listeners") {
      let dto;
      try {
        dto = LiveListenersDTOSchema.parse(JSON.parse(message.data));
      } catch (error) {
        this.emitError(toLiveError(error, this.url));
        return;
      }
      const listeners = liveListenersFromDTO(dto);
      const at = new Date();
      this.currentListeners = { listeners, at };
      this.bufferEvent({ type: "listeners", listeners, receivedAt: at });
      for (const subscriber of this.subscribers) {
        this.safe(() => subscriber.onListeners?.(listeners, at));
      }
    }
  }

  /** Routes a buffered event to one subscriber's handlers (by type). */
  private deliver(subscriber: Subscriber, event: LiveEvent): void {
    if (event.type === "song_change") {
      this.safe(() => subscriber.onSongChange?.(event.song));
    } else if (event.type === "listeners") {
      this.safe(() =>
        subscriber.onListeners?.(event.listeners, event.receivedAt),
      );
    }
  }

  /**
   * Appends an event to the shared inbox: coalesces consecutive trailing
   * `listeners` updates, then drops the oldest events beyond the cap.
   */
  private bufferEvent(event: LiveEvent): void {
    if (this.inboxSize <= 0) return;
    if (
      event.type === "listeners" &&
      this.inbox[this.inbox.length - 1]?.type === "listeners"
    ) {
      this.inbox[this.inbox.length - 1] = event;
      return;
    }
    this.inbox.push(event);
    while (this.inbox.length > this.inboxSize) this.inbox.shift();
  }

  private waitBackoff(): Promise<void> {
    const delay = this.nextDelay();
    return new Promise<void>((resolve) => {
      this.resolveReconnect = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.resolveReconnect = null;
        resolve();
      }, delay);
    });
  }

  private nextDelay(): number {
    const base = Math.min(
      this.maxReconnectDelay,
      this.minReconnectDelay * 2 ** this.attempts,
    );
    this.attempts += 1;
    const jitter =
      this.reconnectJitter > 0
        ? base * this.reconnectJitter * (Math.random() - 0.5)
        : 0;
    return Math.max(0, Math.round(base + jitter));
  }

  private stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const resolve = this.resolveReconnect;
    this.resolveReconnect = null;
    resolve?.();

    this.controller?.abort();
    this.controller = null;

    const remaining = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of remaining) {
      if (subscriber.closed) continue;
      subscriber.closed = true;
      this.safe(() => subscriber.onClose?.());
    }
  }

  private emitOpen(): void {
    for (const subscriber of this.subscribers) {
      this.safe(() => subscriber.onOpen?.());
    }
  }

  private emitError(error: AnimuApiError): void {
    for (const subscriber of this.subscribers) {
      this.safe(() => subscriber.onError?.(error));
    }
  }

  /** Runs a subscriber callback without letting it tear down the stream. */
  private safe(callback: () => void): void {
    try {
      callback();
    } catch {
      // A subscriber throwing must not break fan-out for the others.
    }
  }
}
