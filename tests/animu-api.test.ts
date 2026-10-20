import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimuApi } from "../src/animu-api";
import { AnimuApiError, ValidationError } from "../src/errors";
import { FALLBACK_STREAMS, DEFAULT_COVER, ENDPOINTS } from "../src/endpoints";
import { abortAllInFlightRequests } from "../src/http";
import {
  liveSongChangeNoTimePayload,
  metadataPayload,
  metadataPayloadWithAlias,
  metadataPayloadWithoutTrack,
  playedHistoryPayload,
  programPayload,
  programPayloadAutoDJ,
  requestsHistoryPayload,
  searchResponsePayload,
  streamsPayload,
  userExchangePayload,
} from "./fixtures";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const encoder = new TextEncoder();

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface SSEStreamOptions {
  /** Never enqueue anything (the read waits forever). */
  hang?: boolean;
  /** Enqueue the chunks but leave the stream open (cancel is observable). */
  keepOpen?: boolean;
  /** Called when the reader is cancelled (early snapshot or cleanup). */
  onCancel?: () => void;
  /** Error the stream when this aborts (real fetch cancels the body). */
  signal?: AbortSignal;
}

function sseResponse(
  chunks: string[],
  options: SSEStreamOptions = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      options.signal?.addEventListener("abort", () => {
        controller.error(new Error("aborted"));
      });
      if (options.hang) return;
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!options.keepOpen) controller.close();
    },
    cancel() {
      options.onCancel?.();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

function sseSongChange(data: unknown = metadataPayload): Response {
  return sseResponse([sseEvent("song_change", data)]);
}

/** Routed fake: maps URL → payload. */
function mockFetch(routes: Array<{ match: (url: string) => boolean; reply: (url: string) => Response | Promise<Response> }>) {
  const fn = vi.fn<typeof fetch>(async (input: string | URL | Request) => {
    const url = String(input);
    const route = routes.find((r) => r.match(url));
    if (!route) throw new Error(`Unhandled fetch in test: ${url}`);
    return route.reply(url);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getStreamMetadata", () => {
  it("reads a one-shot snapshot from the live SSE stream", async () => {
    const fetchMock = mockFetch([
      { match: (u) => u === ENDPOINTS.live, reply: () => sseSongChange() },
    ]);

    const { track, listeners } = await new AnimuApi().getStreamMetadata();

    expect(listeners).toEqual({ value: 21 });
    expect(track?.title).toBe("Philosophyz");
    expect(track?.id).toBe("16217");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.animu.moe/tungtungtung/");
    expect(init?.method).toBe("GET");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("text/event-stream");
    expect(headers["User-Agent"]).toBe("animu-api");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("ignores comments and listeners events before the song_change", async () => {
    mockFetch([
      {
        match: () => true,
        reply: () =>
          sseResponse([
            ": keep-alive\n\n",
            sseEvent("listeners", { listeners: 99 }),
            sseEvent("song_change", metadataPayload),
          ]),
      },
    ]);

    const { track, listeners } = await new AnimuApi().getStreamMetadata();

    expect(listeners).toEqual({ value: 21 });
    expect(track?.title).toBe("Philosophyz");
  });

  it("decodes a song_change split across chunks", async () => {
    const raw = sseEvent("song_change", metadataPayload);
    const cut = Math.floor(raw.length / 2);
    mockFetch([
      {
        match: () => true,
        reply: () => sseResponse([raw.slice(0, cut), raw.slice(cut)]),
      },
    ]);

    const { track, listeners } = await new AnimuApi().getStreamMetadata();

    expect(listeners).toEqual({ value: 21 });
    expect(track?.id).toBe("16217");
  });

  it("accepts an unnamed message event carrying the state", async () => {
    mockFetch([
      {
        match: () => true,
        reply: () =>
          sseResponse([`data: ${JSON.stringify(metadataPayload)}\n\n`]),
      },
    ]);

    const { track } = await new AnimuApi().getStreamMetadata();
    expect(track?.title).toBe("Philosophyz");
  });

  it("resolves the currentListeners alias", async () => {
    mockFetch([
      { match: () => true, reply: () => sseSongChange(metadataPayloadWithAlias) },
    ]);
    const { listeners } = await new AnimuApi().getStreamMetadata();
    expect(listeners).toEqual({ value: 7 });
  });

  it("returns a null track when payload lacks track data", async () => {
    mockFetch([
      { match: () => true, reply: () => sseSongChange(metadataPayloadWithoutTrack) },
    ]);
    const { track, listeners } = await new AnimuApi().getStreamMetadata();
    expect(track).toBeNull();
    expect(listeners).toEqual({ value: 3 });
  });

  it('degrades a "notime" duration to 0', async () => {
    mockFetch([
      { match: () => true, reply: () => sseSongChange(liveSongChangeNoTimePayload) },
    ]);

    const { track } = await new AnimuApi().getStreamMetadata();

    expect(track?.duration).toBe(0);
    expect(track?.raw).toBe("DJ Haruka - Live Set [NO AR]");
  });

  it("respects a liveUrl override", async () => {
    const fetchMock = mockFetch([
      {
        match: (u) => u === "https://staging.test/sse/",
        reply: () => sseSongChange(),
      },
    ]);

    await new AnimuApi({ liveUrl: "https://staging.test/sse/" }).getStreamMetadata();

    expect(fetchMock.mock.calls[0]![0]).toBe("https://staging.test/sse/");
  });

  it("throws AnimuApiError on HTTP failure", async () => {
    mockFetch([
      {
        match: () => true,
        reply: () => ({ ok: false, status: 503, body: null } as unknown as Response),
      },
    ]);

    const error = (await new AnimuApi()
      .getStreamMetadata()
      .catch((e) => e)) as AnimuApiError;

    expect(error).toBeInstanceOf(AnimuApiError);
    expect(error.message).toBe("HTTP error 503");
    expect(error.statusCode).toBe(503);
    expect(error.url).toBe(ENDPOINTS.live);
  });

  it("reports a response without a readable body", async () => {
    mockFetch([
      { match: () => true, reply: () => ({ ok: true, status: 200, body: null } as unknown as Response) },
    ]);

    const error = (await new AnimuApi()
      .getStreamMetadata()
      .catch((e) => e)) as AnimuApiError;

    expect(error).toBeInstanceOf(AnimuApiError);
    expect(error.message).toBe("Response has no readable body");
    expect(error.url).toBe(ENDPOINTS.live);
  });

  it("reports an empty stream as a descriptive AnimuApiError", async () => {
    // Regression: an empty body used to reach the valibot schema as `""` and
    // surface as a raw ValiError with no URL/status, spamming the app's logs.
    mockFetch([{ match: () => true, reply: () => sseResponse([]) }]);

    const error = (await new AnimuApi()
      .getStreamMetadata()
      .catch((e) => e)) as AnimuApiError;

    expect(error).toBeInstanceOf(AnimuApiError);
    expect(error.name).toBe("AnimuApiError");
    expect(error.message).toBe("Stream ended before any song_change event");
    expect(error.url).toBe(ENDPOINTS.live);
  });

  it("reports a stream that closes before the first song_change", async () => {
    mockFetch([
      {
        match: () => true,
        reply: () =>
          sseResponse([": hello\n\n", sseEvent("listeners", { listeners: 4 })]),
      },
    ]);

    await expect(new AnimuApi().getStreamMetadata()).rejects.toBeInstanceOf(
      AnimuApiError,
    );
  });

  it("wraps invalid JSON in ValidationError", async () => {
    mockFetch([
      {
        match: () => true,
        reply: () => sseResponse([`event: song_change\ndata: {not json\n\n`]),
      },
    ]);

    const error = (await new AnimuApi()
      .getStreamMetadata()
      .catch((e) => e)) as ValidationError;

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(AnimuApiError);
    expect(error.message).toContain("Invalid response payload");
    expect(error.url).toBe(ENDPOINTS.live);
  });

  it("wraps schema failures in ValidationError", async () => {
    // A malformed (but valid JSON) payload is the schema layer's job; it must
    // still surface as the package's own error type, as the method documents.
    mockFetch([
      {
        match: () => true,
        reply: () =>
          sseResponse([
            `event: song_change\ndata: ${JSON.stringify({ track: "nope" })}\n\n`,
          ]),
      },
    ]);

    const error = (await new AnimuApi()
      .getStreamMetadata()
      .catch((e) => e)) as ValidationError;

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(AnimuApiError);
    expect(error.message).toContain("Invalid response payload");
    expect(error.url).toBe(ENDPOINTS.live);
  });

  it("cancels the reader after the first song_change", async () => {
    let cancelled = false;
    mockFetch([
      {
        match: () => true,
        reply: () =>
          sseResponse(
            [
              sseEvent("song_change", metadataPayload),
              sseEvent("listeners", { listeners: 99 }),
            ],
            {
              keepOpen: true,
              onCancel: () => {
                cancelled = true;
              },
            },
          ),
      },
    ]);

    const { listeners } = await new AnimuApi().getStreamMetadata();

    expect(listeners).toEqual({ value: 21 });
    expect(cancelled).toBe(true);
  });

  it("times out while waiting for the first event", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
      sseResponse([], { hang: true, signal: init?.signal ?? undefined }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new AnimuApi({ timeout: 50 });

    const pending = api.getStreamMetadata();
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AnimuApiError",
      statusCode: 0,
      message: "Request timed out after 50ms",
    });
    await vi.advanceTimersByTimeAsync(50);

    await assertion;
  });

  it("is cancelled by abortAllInFlightRequests()", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
      sseResponse([], { hang: true, signal: init?.signal ?? undefined }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = new AnimuApi({ timeout: 60000 });

    const pending = api.getStreamMetadata();
    const assertion = expect(pending).rejects.toBeInstanceOf(AnimuApiError);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    abortAllInFlightRequests();

    await assertion;
  });

  it("times out a stalled read even when the body ignores the abort", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    // No `signal`: the fake body never errors on abort, like a runtime whose
    // fetch leaves a pending read alone — only cancelling the reader ends it.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        sseResponse([], {
          hang: true,
          onCancel: () => {
            cancelled = true;
          },
        }),
      ),
    );

    const pending = new AnimuApi({ timeout: 50 }).getStreamMetadata();
    const assertion = expect(pending).rejects.toMatchObject({
      message: "Request timed out after 50ms",
    });
    await vi.advanceTimersByTimeAsync(50);

    await assertion;
    expect(cancelled).toBe(true);
  });

  it("stays abortable through options.signal while waiting for the event", async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return sseResponse([], { hang: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const scope = new AbortController();

    const pending = new AnimuApi({ timeout: 60000 }).getStreamMetadata({
      signal: scope.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AnimuApiError",
      message: "Request aborted",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    scope.abort();

    await assertion;
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("gives up on a stalled error body when the caller aborts", async () => {
    let bodyCancelled = false;
    const fetchMock = vi.fn<typeof fetch>(async () => ({
      ok: false,
      status: 502,
      text: () => new Promise<string>(() => {}),
      body: {
        cancel: async () => {
          bodyCancelled = true;
        },
      },
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const scope = new AbortController();

    const pending = new AnimuApi({ timeout: 60000 }).getStreamMetadata({
      signal: scope.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AnimuApiError",
      message: "Request aborted",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    scope.abort();

    await assertion;
    expect(bodyCancelled).toBe(true);
  });

  it("does not connect when options.signal is already aborted", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.signal?.aborted) throw new Error("aborted");
      return sseSongChange();
    });
    vi.stubGlobal("fetch", fetchMock);
    const scope = new AbortController();
    scope.abort();

    await expect(
      new AnimuApi().getStreamMetadata({ signal: scope.signal }),
    ).rejects.toBeInstanceOf(AnimuApiError);
  });

  it("keeps the server's error envelope on HTTP failures", async () => {
    mockFetch([
      {
        match: () => true,
        reply: () =>
          jsonResponse(
            { ok: false, error: { code: "maintenance", message: "Voltamos já" } },
            503,
          ),
      },
    ]);

    const error = (await new AnimuApi()
      .getStreamMetadata()
      .catch((e: unknown) => e)) as AnimuApiError;

    expect(error).toBeInstanceOf(AnimuApiError);
    expect(error.statusCode).toBe(503);
    expect(error.message).toBe("Voltamos já");
    expect(error.code).toBe("maintenance");
    expect(error.url).toBe(ENDPOINTS.live);
  });
});

describe("getProgram", () => {
  it("maps a live DJ program", async () => {
    mockFetch([{ match: (u) => u.includes("locutor.php"), reply: () => jsonResponse(programPayload) }]);
    const program = await new AnimuApi().getProgram();
    expect(program.isLive).toBe(true);
    expect(program.dj).toBe("Dolode");
  });

  it("maps AutoDJ as not live", async () => {
    mockFetch([{ match: () => true, reply: () => jsonResponse(programPayloadAutoDJ) }]);
    const program = await new AnimuApi().getProgram();
    expect(program.isLive).toBe(false);
  });

  it("degrades malformed payloads instead of throwing", async () => {
    mockFetch([{ match: () => true, reply: () => jsonResponse({ locutor: 1 }) }]);
    const program = await new AnimuApi().getProgram();
    expect(program.name).toBe("");
  });
});

describe("getTrackHistory", () => {
  it("hits the played endpoint and drops ident/invalid rows", async () => {
    const fetchMock = mockFetch([
      { match: (u) => u.includes("ultimasmusicas"), reply: () => jsonResponse(playedHistoryPayload) },
    ]);
    const tracks = await new AnimuApi().getTrackHistory("played");

    expect(fetchMock.mock.calls[0]![0]).toContain("ultimasmusicas_json.php");
    expect(tracks).toHaveLength(2);
  });

  it("hits the requests endpoint", async () => {
    const fetchMock = mockFetch([
      { match: (u) => u.includes("ultimospedidos"), reply: () => jsonResponse(requestsHistoryPayload) },
    ]);
    const tracks = await new AnimuApi().getTrackHistory("requests");

    expect(fetchMock.mock.calls[0]![0]).toContain("ultimospedidos_json.php");
    expect(tracks[0]?.id).toBe("9126");
  });
});

describe("searchMusic", () => {
  it("sends params and returns pagination", async () => {
    const fetchMock = mockFetch([
      { match: (u) => u.includes("requestSearchTest"), reply: () => jsonResponse(searchResponsePayload) },
    ]);
    const api = new AnimuApi();

    const page = await api.searchMusic({ server: 1, query: "attack", limit: 25, offset: 0 });

    expect(fetchMock.mock.calls[0]![0]).toContain("query=attack");
    expect(page.totalResults).toBe(34);
    expect(page.nextPageParams?.offset).toBe(25);
    expect(page.results[0]?.song).toBe("Aegis of Love");
  });

  it("searchMusicByTitle uses the documented defaults", async () => {
    const fetchMock = mockFetch([
      { match: () => true, reply: () => jsonResponse(searchResponsePayload) },
    ]);

    await new AnimuApi().searchMusicByTitle("attack");

    expect(fetchMock.mock.calls[0]![0]).toContain("server=1");
    expect(fetchMock.mock.calls[0]![0]).toContain("requestable=true");
    expect(fetchMock.mock.calls[0]![0]).toContain("limit=25");
  });

  it("result rows follow the client's artwork quality setting", async () => {
    mockFetch([
      { match: () => true, reply: () => jsonResponse(searchResponsePayload) },
    ]);

    const medium = await new AnimuApi({ artworkQuality: "medium" }).searchMusic({
      server: 1,
      query: "attack",
      limit: 25,
      offset: 0,
    });
    // Row 1 only exposes image_tiny → the medium chain lands on tiny
    expect(medium.results[1]?.artwork).toBe(
      "https://www.animu.moe//media/tracks/trackImage9200_tiny.jpg",
    );

    const low = await new AnimuApi({ artworkQuality: "off" }).searchMusic({
      server: 1,
      query: "attack",
      limit: 25,
      offset: 0,
    });
    // Covers off → rows never carry a remote URL (saves data everywhere)
    for (const result of low.results) {
      expect(result.artwork).toBe(DEFAULT_COVER);
    }
  });
});

describe("submitMusicRequest", () => {
  it("posts FormData without a client-type flag and parses the result", async () => {
    const fetchMock = mockFetch([
      { match: (u) => u.includes("pedirquatro"), reply: () => jsonResponse("") },
    ]);

    const result = await new AnimuApi().submitMusicRequest({
      trackId: "9126",
      message: "pls",
      sessionId: "sess-1",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).not.toContain("mobileapp");
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(form.get("allmusic")).toBe("9126");
    expect(form.get("PHPSESSID")).toBe("sess-1");
    expect(result).toEqual({ success: true });
  });

  it("surfaces structured block errors", async () => {
    mockFetch([
      { match: () => true, reply: () => jsonResponse('{"pediblock":"2026-09-03 14:00"}') },
    ]);

    const result = await new AnimuApi().submitMusicRequest({
      trackId: "1",
      sessionId: "s",
    });
    expect(result).toEqual({
      success: false,
      error: "PEDIBLOCK",
      detail: "2026-09-03 14:00",
    });
  });
});

describe("submitLiveRequest", () => {
  const valid = { name: "a", city: "b", artist: "c", music: "d", anime: "e" };

  it("posts the form and returns true for a '1' response", async () => {
    const fetchMock = mockFetch([
      { match: (u) => u.includes("salvar.php"), reply: () => jsonResponse("1") },
    ]);

    const ok = await new AnimuApi().submitLiveRequest({ ...valid, request: "hi" });

    expect(ok).toBe(true);
    const form = (fetchMock.mock.calls[0]![1]?.body as FormData);
    expect(form.get("request")).toBe("hi");
  });

  it("returns false for any other response", async () => {
    mockFetch([{ match: () => true, reply: () => jsonResponse("0") }]);
    expect(await new AnimuApi().submitLiveRequest(valid)).toBe(false);
  });

  it("throws ValidationError for invalid input without hitting the network", async () => {
    const fetchMock = mockFetch([]);
    const api = new AnimuApi();

    await expect(api.submitLiveRequest({ ...valid, name: "" })).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false when the network fails", async () => {
    mockFetch([{ match: () => true, reply: () => jsonResponse("x", 500) }]);
    expect(await new AnimuApi().submitLiveRequest(valid)).toBe(false);
  });
});

describe("getStreams", () => {
  it("fetches, coerces and caches the stream list", async () => {
    const fetchMock = mockFetch([
      { match: (u) => u.includes("stream.animu.moe"), reply: () => jsonResponse(streamsPayload) },
    ]);
    const api = new AnimuApi();

    const streams = await api.getStreams();
    expect(streams).toEqual([
      { id: "320", bitrate: 320, category: "MP3", url: "https://stream.animu.moe/320" },
      { id: "192", bitrate: 192, category: "MP3", url: "https://stream.animu.moe/192" },
    ]);

    await api.getStreams();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await api.getStreams(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the built-in list on failure and stays resilient", async () => {
    mockFetch([{ match: () => true, reply: () => jsonResponse("garbage", 500) }]);
    const api = new AnimuApi();

    const streams = await api.getStreams();
    expect(streams.map((s) => s.id)).toEqual(FALLBACK_STREAMS.map((s) => s.id));
  });

  it("uses custom fallback streams from options", async () => {
    const custom = [{ id: "x", bitrate: 1, category: "X", url: "https://x.co/1" }];
    mockFetch([{ match: () => true, reply: () => jsonResponse("bad", 500) }]);

    const streams = await new AnimuApi({ fallbackStreams: custom }).getStreams();
    expect(streams).toEqual(custom);
  });

  it("clearStreamsCache forces a refetch", async () => {
    const fetchMock = mockFetch([
      { match: () => true, reply: () => jsonResponse(streamsPayload) },
    ]);
    const api = new AnimuApi();

    await api.getStreams();
    api.clearStreamsCache();
    await api.getStreams();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("validateSession / logout", () => {
  it("returns true only for a '1' response", async () => {
    const fetchMock = mockFetch([
      { match: (u) => u.includes("chatIsThisReal"), reply: () => jsonResponse("1") },
    ]);

    expect(await new AnimuApi().validateSession("sess-1")).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toContain("PHPSESSID=sess-1");
  });

  it("returns false for other responses", async () => {
    mockFetch([{ match: () => true, reply: () => jsonResponse("0") }]);
    expect(await new AnimuApi().validateSession("expired")).toBe(false);
  });

  it("returns false on network errors", async () => {
    mockFetch([{ match: () => true, reply: () => jsonResponse("x", 500) }]);
    expect(await new AnimuApi().validateSession("sess")).toBe(false);
  });

  it("logout never throws, even on failure", async () => {
    mockFetch([{ match: () => true, reply: () => jsonResponse("err", 500) }]);
    await expect(new AnimuApi().logout("sess")).resolves.toBeUndefined();
  });
});

describe("exchangeToken", () => {
  const params = { code: "oauth-code", redirectUri: "animuapp://redirect", codeVerifier: "verifier" };

  it("POSTs urlencoded params and maps the user", async () => {
    const fetchMock = mockFetch([
      { match: (u) => u.includes("exchange-token"), reply: () => jsonResponse(userExchangePayload) },
    ]);

    const user = await new AnimuApi().exchangeToken(params);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("exchange-token.php");
    expect(init?.method).toBe("POST");
    const body = init?.body as string;
    expect(body).toContain("code=oauth-code");
    expect(body).toContain("code_verifier=verifier");
    expect(user.sessionId).toBe("sess-abc123");
    expect(user.mfa).toBe(true);
  });

  it("throws on server-reported errors", async () => {
    mockFetch([
      { match: () => true, reply: () => jsonResponse({ error: "invalid_grant" }, 400) },
    ]);

    await expect(new AnimuApi().exchangeToken(params)).rejects.toMatchObject({
      name: "AnimuApiError",
      statusCode: 400,
    });
  });

  it("throws when the response is not JSON", async () => {
    mockFetch([{ match: () => true, reply: () => jsonResponse("<html>boom</html>") }]);

    await expect(new AnimuApi().exchangeToken(params)).rejects.toThrow(/not valid JSON/);
  });
});

describe("options", () => {
  it("uses a neutral default user agent, not a client-specific one", async () => {
    const fetchMock = mockFetch([
      { match: () => true, reply: () => sseSongChange() },
    ]);

    await new AnimuApi().getStreamMetadata();

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("animu-api");
  });

  it("applies custom user agent, timeout and artwork quality", async () => {
    const fetchMock = mockFetch([
      { match: () => true, reply: () => sseSongChange() },
    ]);

    const { track } = await new AnimuApi({
      userAgent: "Custom/1.0",
      artworkQuality: "low",
    }).getStreamMetadata();

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("Custom/1.0");
    expect(track?.artwork).toBe(metadataPayload.track.artworks.tiny);
  });

  it("derives a structured user agent and X-Client-* headers from clientInfo", async () => {
    const fetchMock = mockFetch([
      { match: () => true, reply: () => sseSongChange() },
    ]);

    await new AnimuApi({
      clientInfo: {
        app: "animu-mobile",
        platform: "ios",
        version: "2.1.0",
        build: "3",
        os: "iOS",
        osVersion: "27",
        model: "iPhone 17 Pro Max",
        language: "pt-BR",
      },
    }).getStreamMetadata();

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(
      "RadioAnimu/2.1.0 (iOS 27; iPhone 17 Pro Max; pt-BR; build 3)",
    );
    expect(headers["X-Client-Platform"]).toBe("ios");
    expect(headers["X-Client-App"]).toBe("animu-mobile");
    expect(headers["X-Client-Version"]).toBe("2.1.0");
    expect(headers["X-Device-Model"]).toBe("iPhone 17 Pro Max");
  });

  it("omits X-Client-* headers for the web platform", async () => {
    const fetchMock = mockFetch([
      { match: () => true, reply: () => sseSongChange() },
    ]);

    await new AnimuApi({
      clientInfo: { platform: "web", os: "Web", language: "en-US" },
    }).getStreamMetadata();

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Client-Platform"]).toBeUndefined();
    expect(headers["User-Agent"]).toBe("RadioAnimu/0 (Web; en-US)");
  });
});
