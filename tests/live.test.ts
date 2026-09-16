import { describe, expect, it, vi } from "vitest";
import { AnimuApi } from "../src/animu-api";
import type { FetchLike } from "../src/http";
import { AnimuLive, SSEDecoder } from "../src/live";
import { liveListenersFromDTO, liveNowPlayingFromDTO } from "../src/mappers";
import { LiveListenersDTOSchema, LiveSongChangeDTOSchema } from "../src/schemas";
import {
  liveListenersPayload,
  liveSongChangeNoTimePayload,
  liveSongChangeOfflinePayload,
  liveSongChangePayload,
} from "./fixtures";

const encoder = new TextEncoder();
const LIVE_URL = "https://api.animu.moe/tungtungtung/";

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

function hangingResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function waitFor(assertion: () => void, timeout = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("SSEDecoder", () => {
  it("decodes a complete event", () => {
    const decoder = new SSEDecoder();
    expect(decoder.push(`event: song_change\ndata: {"a":1}\n\n`)).toEqual([
      { event: "song_change", data: '{"a":1}' },
    ]);
  });

  it("joins multi-line data with newlines and ignores comments", () => {
    const decoder = new SSEDecoder();
    expect(decoder.push(": keep-alive\ndata: line1\ndata: line2\n\n")).toEqual([
      { event: "message", data: "line1\nline2" },
    ]);
  });

  it("buffers events split across chunk boundaries", () => {
    const decoder = new SSEDecoder();
    expect(decoder.push("event: listeners\nda")).toEqual([]);
    expect(decoder.push(`ta: {"listeners":5}\n`)).toEqual([]);
    expect(decoder.push("\n")).toEqual([
      { event: "listeners", data: '{"listeners":5}' },
    ]);
  });

  it("handles CRLF and lone CR line endings", () => {
    const decoder = new SSEDecoder();
    expect(decoder.push("data: one\r\n\r\n")).toEqual([
      { event: "message", data: "one" },
    ]);
    expect(decoder.push("data: two\r\r")).toEqual([
      { event: "message", data: "two" },
    ]);
  });

  it("captures id and retry fields", () => {
    const decoder = new SSEDecoder();
    expect(decoder.push("id: 42\nretry: 3000\ndata: x\n\n")).toEqual([
      { event: "message", data: "x", id: "42", retry: 3000 },
    ]);
  });

  it("does not dispatch events with no data", () => {
    const decoder = new SSEDecoder();
    expect(decoder.push("event: ping\n\n")).toEqual([]);
  });
});

describe("live mappers", () => {
  it("maps a song_change DTO to a LiveNowPlaying", () => {
    const dto = LiveSongChangeDTOSchema.parse(liveSongChangePayload);
    const song = liveNowPlayingFromDTO(dto, "medium", "fallback.png");

    expect(song.serverName).toBe(
      "Animu FM Radio Station - The Most Moe Radio of Brazil!",
    );
    expect(song.status).toBe("autodj");
    expect(song.album).toBe("きくおミク3");
    expect(song.track?.title).toBe("Kimi wa Dekinai Ko");
    expect(song.track?.artist).toBe("Kikuo feat. Hatsune Miku");
    expect(song.track?.id).toBe("9502");
    expect(song.track?.duration).toBe(262600);
    expect(song.listeners.value).toBe(22);
  });

  it("maps a listeners DTO", () => {
    const dto = LiveListenersDTOSchema.parse(liveListenersPayload);
    expect(liveListenersFromDTO(dto)).toEqual({ value: 25 });
  });

  it("degrades an unresolved duration ('notime') to 0", () => {
    const dto = LiveSongChangeDTOSchema.parse(liveSongChangeNoTimePayload);
    const song = liveNowPlayingFromDTO(dto, "medium", "fallback.png");
    expect(song.track?.duration).toBe(0);
  });

  it("maps the offline station payload", () => {
    const dto = LiveSongChangeDTOSchema.parse(liveSongChangeOfflinePayload);
    const song = liveNowPlayingFromDTO(dto, "medium", "fallback.png");

    expect(song.status).toBe("offline");
    expect(song.offlineSince).toBe("2026-09-16T18:00:00Z");
    expect(song.message).toBe(
      "Servidor temporariamente offline — voltamos em breve!",
    );
    expect(song.listeners.value).toBe(0);
    expect(song.track?.artist).toBe("Rádio Animu");
  });

  it("maps a live payload without offline fields to null", () => {
    const dto = LiveSongChangeDTOSchema.parse(liveSongChangePayload);
    const song = liveNowPlayingFromDTO(dto, "medium", "fallback.png");
    expect(song.offlineSince).toBeNull();
    expect(song.message).toBeNull();
  });
});

describe("AnimuLive", () => {
  it("fans out song_change and listeners to subscribers", async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        sseEvent("song_change", liveSongChangePayload),
        sseEvent("listeners", liveListenersPayload),
      ]);
    const live = new AnimuLive({ fetchImpl, reconnect: false, url: LIVE_URL });

    const songs: string[] = [];
    const listenerCounts: number[] = [];
    const sub = live.subscribe({
      onSongChange: (song) => songs.push(song.track?.title ?? ""),
      onListeners: (listeners) => listenerCounts.push(listeners.value),
    });

    await waitFor(() => expect(songs).toEqual(["Kimi wa Dekinai Ko"]));
    expect(listenerCounts).toEqual([22, 25]);
    sub.close();
  });

  it("shares one connection across multiple subscribers", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([sseEvent("song_change", liveSongChangePayload)]),
    );
    const live = new AnimuLive({ fetchImpl, reconnect: false, url: LIVE_URL });

    const a: number[] = [];
    const b: number[] = [];
    const subA = live.subscribe({ onSongChange: (s) => a.push(s.listeners.value) });
    const subB = live.subscribe({ onSongChange: (s) => b.push(s.listeners.value) });

    await waitFor(() => {
      expect(a).toEqual([22]);
      expect(b).toEqual([22]);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    subA.close();
    subB.close();
  });

  it("reconnects after the stream drops", async () => {
    const secondSong = {
      ...liveSongChangePayload,
      rawtitle: "LiSA - crossing field",
      listeners: 30,
      track: {
        ...liveSongChangePayload.track,
        title: "crossing field",
        artist: "LiSA",
      },
    };
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) {
        return sseResponse([sseEvent("song_change", liveSongChangePayload)]);
      }
      if (calls === 2) {
        return sseResponse([sseEvent("song_change", secondSong)]);
      }
      return hangingResponse();
    };
    const live = new AnimuLive({
      fetchImpl,
      minReconnectDelay: 1,
      maxReconnectDelay: 2,
      reconnectJitter: 0,
      url: LIVE_URL,
    });

    const titles: string[] = [];
    const sub = live.subscribe({
      onSongChange: (song) => titles.push(song.track?.title ?? ""),
    });

    await waitFor(() => {
      expect(titles).toEqual(["Kimi wa Dekinai Ko", "crossing field"]);
      expect(calls).toBeGreaterThanOrEqual(3);
    });
    sub.close();
  });

  it("opens on the first subscriber and closes on the last", async () => {
    const fetchImpl: FetchLike = async () => hangingResponse();
    const live = new AnimuLive({ fetchImpl, url: LIVE_URL });

    const sub = live.subscribe({});
    await waitFor(() => expect(live.connected).toBe(true));

    sub.close();
    expect(live.connected).toBe(false);
    expect(sub.closed).toBe(true);
  });

  it("replays the last song to late subscribers", async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([sseEvent("song_change", liveSongChangePayload)]);
    const live = new AnimuLive({ fetchImpl, reconnect: false, url: LIVE_URL });

    const first = live.subscribe({ onSongChange: () => {} });
    await waitFor(() => expect(live.lastSong).not.toBeNull());

    const titles: string[] = [];
    const second = live.subscribe({
      onSongChange: (song) => titles.push(song.track?.title ?? ""),
    });
    await waitFor(() => expect(titles[0]).toBe("Kimi wa Dekinai Ko"));
    expect(live.lastListeners).toEqual({ value: 22 });

    first.close();
    second.close();
  });

  it("emits an error for malformed payloads without crashing", async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse(["event: song_change\ndata: {not json}\n\n"]);
    const live = new AnimuLive({ fetchImpl, reconnect: false, url: LIVE_URL });

    const errors: Error[] = [];
    const sub = live.subscribe({ onError: (error) => errors.push(error) });
    await waitFor(() =>
      expect(errors.some((e) => /not valid JSON/.test(e.message))).toBe(true),
    );
    sub.close();
  });

  it("decodes UTF-8 split across chunks via a duck-typed custom fetch", async () => {
    const frame = sseEvent("song_change", liveSongChangePayload); // album: "きくおミク3"
    const bytes = encoder.encode(frame);
    // Cut inside a multi-byte character (a continuation byte: 10xxxxxx).
    let cut = 1;
    while ((bytes[cut]! & 0xc0) === 0x80) cut++;
    while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
    cut++;
    const response = {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, cut));
          controller.enqueue(bytes.slice(cut));
          controller.close();
        },
      }),
    } as unknown as Response;

    // Bare duck-typed fetch — no native fetch contract, just the FetchLike shape.
    const fetchImpl: FetchLike = async () => response;
    const live = new AnimuLive({ fetchImpl, reconnect: false, url: LIVE_URL });

    const albums: string[] = [];
    const sub = live.subscribe({
      onSongChange: (song) => albums.push(song.album),
    });
    await waitFor(() => expect(albums).toEqual(["きくおミク3"]));
    sub.close();
  });

  it("yields typed events through the async iterator", async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        sseEvent("song_change", liveSongChangePayload),
        sseEvent("listeners", liveListenersPayload),
      ]);
    const live = new AnimuLive({ fetchImpl, reconnect: false, url: LIVE_URL });

    const types: string[] = [];
    for await (const event of live.events()) {
      types.push(event.type);
      if (event.type === "listeners") break;
    }

    expect(types).toEqual(["open", "song_change", "listeners"]);
    live.close();
  });

  it("is exposed as a shared instance via AnimuApi", () => {
    const api = new AnimuApi();
    expect(api.live).toBe(api.live);
  });
});
