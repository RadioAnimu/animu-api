import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artworkSizeRank,
  deriveArtworkVariants,
  getTrackProgress,
  historyFromDTO,
  isRealTrack,
  listenersFromMetadata,
  musicRequestFromDTO,
  paginationFromDTO,
  parseNowPlayingTitle,
  parseQueryParams,
  parseRequestTitle,
  parseSubmissionResponse,
  programFromDTO,
  selectArtwork,
  trackFromMetadata,
  userFromExchangePayload,
  validateLiveRequest,
} from "../src/mappers";
import type { Track } from "../src/types";
import type { MusicRequestDTO } from "../src/schemas";
import {
  MusicRequestResponseDTOSchema,
  StreamMetadataDTOSchema,
} from "../src/schemas";
import { DEFAULT_COVER } from "../src/endpoints";
import {
  metadataPayload,
  metadataPayloadWithAlias,
  playedHistoryPayload,
  programPayload,
  programPayloadAutoDJ,
  requestsHistoryPayload,
  searchResponsePayload,
  userExchangePayload,
} from "./fixtures";

afterEach(() => {
  vi.useRealTimers();
});

describe("parseNowPlayingTitle", () => {
  it("splits 'Artist - Title | Anime'", () => {
    expect(
      parseNowPlayingTitle("LiSA - Gurenge | Kimetsu no Yaiba"),
    ).toEqual({ title: "Gurenge", artist: "LiSA", anime: "Kimetsu no Yaiba" });
  });

  it("keeps the whole main part as title when there is no dash", () => {
    expect(parseNowPlayingTitle("Just A Title | Anime")).toEqual({
      title: "Just A Title",
      artist: "",
      anime: "Anime",
    });
  });

  it("falls back to the neutral anime fallback when no separator", () => {
    expect(parseNowPlayingTitle("Artist - Song").anime).toBe("Now Playing");
  });

  it("accepts a custom anime fallback", () => {
    expect(parseNowPlayingTitle("Artist - Song", "Tocando Agora").anime).toBe("Tocando Agora");
  });

  it("handles empty raw titles", () => {
    expect(parseNowPlayingTitle("")).toEqual({
      title: "",
      artist: "",
      anime: "Now Playing",
    });
  });
});

describe("parseRequestTitle", () => {
  it("splits 'Artist-Title|Anime' without spaces", () => {
    expect(parseRequestTitle("LiSA-Gurenge|Kimetsu no Yaiba")).toEqual({
      song: "Gurenge",
      anime: "Kimetsu no Yaiba",
      artist: "LiSA",
    });
  });

  it("falls back to unknown placeholders", () => {
    // No dash: the whole part becomes the artist (matches app behavior)
    expect(parseRequestTitle("Solo Song")).toEqual({
      song: "Solo Song",
      anime: "Unknown Anime",
      artist: "Solo Song",
    });
  });
});

describe("selectArtwork", () => {
  const artworks = {
    tiny: "https://x.co/tiny.png",
    medium: "https://x.co/medium.png",
    large: "https://x.co/large.png",
  };

  it("prefers the requested quality with fallback chain", () => {
    expect(selectArtwork(artworks, "high")).toBe(artworks.large);
    expect(selectArtwork(artworks, "medium")).toBe(artworks.medium);
    expect(selectArtwork(artworks, "low")).toBe(artworks.tiny);
  });

  it("falls down the chain when the preferred size is missing", () => {
    expect(selectArtwork({ large: artworks.large }, "high")).toBe(artworks.large);
    expect(selectArtwork({ tiny: artworks.tiny }, "high")).toBe(artworks.tiny);
    expect(selectArtwork({ tiny: artworks.tiny }, "medium")).toBe(artworks.tiny);
  });

  it("medium quality only falls back to tiny, never large (app parity)", () => {
    expect(selectArtwork({ large: artworks.large }, "medium")).toBe(DEFAULT_COVER);
  });

  it("returns default cover for 'off' quality, missing artworks or non-image urls", () => {
    expect(selectArtwork(artworks, "off")).toBe(DEFAULT_COVER);
    expect(selectArtwork(undefined, "high")).toBe(DEFAULT_COVER);
    expect(selectArtwork({ tiny: "https://x.co/not-an-image" }, "low")).toBe(DEFAULT_COVER);
  });
});

describe("deriveArtworkVariants / artworkSizeRank", () => {
  it("derives all sibling sizes for a suffixed CDN URL", () => {
    expect(
      deriveArtworkVariants("https://www.animu.moe/media/tracks/trackImage16217_medium.jpg"),
    ).toEqual({
      tiny: "https://www.animu.moe/media/tracks/trackImage16217_tiny.jpg",
      medium: "https://www.animu.moe/media/tracks/trackImage16217_medium.jpg",
      large: "https://www.animu.moe/media/tracks/trackImage16217_large.jpg",
    });
  });

  it("derives variants for a suffixless base image", () => {
    expect(
      deriveArtworkVariants("https://www.animu.moe/media/tracks/trackImage9502.jpg"),
    ).toEqual({
      tiny: "https://www.animu.moe/media/tracks/trackImage9502_tiny.jpg",
      medium: "https://www.animu.moe/media/tracks/trackImage9502_medium.jpg",
      large: "https://www.animu.moe/media/tracks/trackImage9502_large.jpg",
    });
  });

  it("keeps query strings out of the rewritten paths", () => {
    expect(
      deriveArtworkVariants("https://x.co/media/tracks/trackImage1_tiny.webp?v=2"),
    ).toEqual({
      tiny: "https://x.co/media/tracks/trackImage1_tiny.webp",
      medium: "https://x.co/media/tracks/trackImage1_medium.webp",
      large: "https://x.co/media/tracks/trackImage1_large.webp",
    });
  });

  it("returns null for URLs without the trackImage naming (cannot be rewritten)", () => {
    expect(deriveArtworkVariants("https://www.animu.moe/media/tracks/cover.jpg")).toBeNull();
  });

  it("derives the same scheme on any host (naming is what matters)", () => {
    expect(deriveArtworkVariants("https://cdn.other/12/trackImage1.png")).toMatchObject({
      large: "https://cdn.other/12/trackImage1_large.png",
    });
  });

  it("sizes rank tiny < medium < large", () => {
    expect(artworkSizeRank("https://x.co/trackImage1_tiny.jpg")).toBe("tiny");
    expect(artworkSizeRank("https://x.co/trackImage1_medium.jpg")).toBe("medium");
    expect(artworkSizeRank("https://x.co/trackImage1_large.jpg")).toBe("large");
    expect(artworkSizeRank("https://x.co/trackImage1.jpg")).toBe("medium");
  });
});

describe("trackFromMetadata", () => {
  it("maps a full metadata payload", () => {
    const dto = StreamMetadataDTOSchema.parse(metadataPayload);
    const track = trackFromMetadata(dto, "medium", DEFAULT_COVER);

    expect(track).toMatchObject({
      id: "16217",
      title: "Philosophyz",
      artist: "Runa Mizutani",
      anime: "Re︰Change ～Rewrite EDM Arrange Album～",
      isRequest: false,
      duration: 264000,
      artwork: metadataPayload.track.artworks.medium,
    });
    expect(track?.startTime).toEqual(new Date(1788408452000));
  });

  it("flags pedidos as requests", () => {
    const dto = StreamMetadataDTOSchema.parse({
      ...metadataPayload,
      rawtitle: "Pedido: LiSA - Gurenge | Kimetsu no Yaiba",
    });
    expect(trackFromMetadata(dto, "medium", DEFAULT_COVER)?.isRequest).toBe(true);
  });

  it("prefers the server-resolved track artist/title over the rawtitle parse", () => {
    const dto = StreamMetadataDTOSchema.parse({
      ...metadataPayload,
      rawtitle: "Raw Artist - Raw Title | Raw Anime",
    });
    const track = trackFromMetadata(dto, "medium", DEFAULT_COVER);
    expect(track?.artist).toBe("Runa Mizutani");
    expect(track?.title).toBe("Philosophyz");
  });

  it("falls back to the rawtitle parse when the track omits artist/title", () => {
    const dto = StreamMetadataDTOSchema.parse(metadataPayloadWithAlias);
    const track = trackFromMetadata(dto, "medium", DEFAULT_COVER);
    expect(track?.artist).toBe("Yuki Kajiura");
    expect(track?.title).toBe("track of twilight");
  });

  it("splits the anime out of a server title that still embeds it", () => {
    // The Go daemon's titleBreaker only splits on " - ", so its track.title
    // keeps the "| Anime" suffix — the rawtitle parse must win in that case.
    const dto = StreamMetadataDTOSchema.parse({
      ...metadataPayload,
      rawtitle: "Toguro Otouto - Cry Lonely Cry | Yu Yu Hakusho",
      track: {
        ...metadataPayload.track,
        artist: "Toguro Otouto",
        title: "Cry Lonely Cry | Yu Yu Hakusho",
      },
    });
    const track = trackFromMetadata(dto, "medium", DEFAULT_COVER);
    expect(track?.title).toBe("Cry Lonely Cry");
    expect(track?.anime).toBe("Yu Yu Hakusho");
    expect(track?.artist).toBe("Toguro Otouto");
  });

  it("exposes the playlist name", () => {
    const dto = StreamMetadataDTOSchema.parse({
      ...metadataPayload,
      track: { ...metadataPayload.track, playlist: { track_id: 1, title: "Animu Toca" } },
    });
    expect(trackFromMetadata(dto, "medium", DEFAULT_COVER)?.playlistName).toBe(
      "Animu Toca",
    );
    expect(trackFromMetadata(
      StreamMetadataDTOSchema.parse(metadataPayload),
      "medium",
      DEFAULT_COVER,
    )?.playlistName).toBe("");
  });

  it("returns null when the payload has no track object", () => {
    expect(trackFromMetadata({} as never, "medium", DEFAULT_COVER)).toBeNull();
  });

  it("guards a zero timestart with the current time", () => {
    vi.useFakeTimers({ now: 1788408452000 });
    const dto = StreamMetadataDTOSchema.parse({
      ...metadataPayload,
      track: { ...metadataPayload.track, timestart: "0" },
    });
    expect(trackFromMetadata(dto, "medium", DEFAULT_COVER)?.startTime).toEqual(
      new Date(1788408452000),
    );
  });
});

describe("listenersFromMetadata", () => {
  it("resolves the first known alias", () => {
    expect(listenersFromMetadata({ listeners: 10, total: 99 })).toEqual({ value: 10 });
    expect(listenersFromMetadata({ active_listeners: "4" })).toEqual({ value: 4 });
  });

  it("clamps invalid values to zero", () => {
    expect(listenersFromMetadata({ listeners: -5 })).toEqual({ value: 0 });
    expect(listenersFromMetadata({ listeners: "abc" })).toEqual({ value: 0 });
    expect(listenersFromMetadata({})).toEqual({ value: 0 });
  });
});

describe("programFromDTO", () => {
  it("maps a live program", () => {
    const program = programFromDTO(programPayload as never);
    expect(program).toEqual({
      name: "Natsukashii",
      dj: "Dolode",
      isLive: true,
      imageUrl: programPayload.imagem,
      info: "Nostalgia pura.",
      theme: "Clássicas",
      acceptingRequests: true,
    });
  });

  it("maps AutoDJ as not live and requests closed", () => {
    const program = programFromDTO(programPayloadAutoDJ as never);
    expect(program.isLive).toBe(false);
    expect(program.dj).toBe("Haruka Yuki");
    expect(program.acceptingRequests).toBe(false);
  });
});

describe("historyFromDTO", () => {
  it("maps played history using element [1] as cover", () => {
    const tracks = historyFromDTO(playedHistoryPayload, "played", "medium", DEFAULT_COVER);
    expect(tracks).toHaveLength(2); // "animu" ident row dropped
    expect(tracks[0]).toMatchObject({
      id: "-1",
      title: "Renai Circulation",
      artist: "Kana Hanazawa",
      anime: "Bakemonogatari",
      artwork: "https://www.animu.moe/media/tracks/cover.jpg",
      isRequest: true,
      duration: 0,
    });
  });

  it("maps requests history using [2] as id, [3] as cover and [1] as time", () => {
    // Fake clock at 18:00Z (15:00 São Paulo) — AFTER the rows' time-of-day,
    // so they anchor to the same São Paulo day regardless of runner TZ
    vi.useFakeTimers({ now: new Date("2026-09-03T18:00:00Z") });
    const tracks = historyFromDTO(requestsHistoryPayload, "requests", "medium", DEFAULT_COVER);
    expect(tracks).toHaveLength(2);

    expect(tracks[0]).toMatchObject({
      id: "9126",
      title: "Again",
      artist: "Yui",
      anime: "FMA Brotherhood",
      artwork: "https://www.animu.moe/media/tracks/req.jpg",
    });
    // "14:32:05" is São Paulo wall clock (UTC-3) → 17:32:05Z
    expect(tracks[0]?.startTime).toEqual(new Date("2026-09-03T17:32:05Z"));
  });

  it("returns [] for garbage input", () => {
    expect(historyFromDTO(null, "played", "medium", DEFAULT_COVER)).toEqual([]);
    expect(historyFromDTO("nope", "played", "medium", DEFAULT_COVER)).toEqual([]);
  });

  it("uses the default cover when the row has none", () => {
    const tracks = historyFromDTO([["Artist - Title | Anime", ""]], "played", "medium", DEFAULT_COVER);
    expect(tracks[0]?.artwork).toBe(DEFAULT_COVER);
  });
});

describe("musicRequestFromDTO + paginationFromDTO", () => {
  it("maps title, artwork from the web base and requestability", () => {
    const dto = MusicRequestResponseDTOSchema.parse(searchResponsePayload);
    const first = musicRequestFromDTO(dto.objects[0]!, "high", DEFAULT_COVER);
    expect(first).toEqual({
      id: "9126",
      raw: "Aegis of Love|Ijiranaide, Nagatoro-san 2nd Attack",
      song: "Aegis of Love",
      anime: "Ijiranaide, Nagatoro-san 2nd Attack",
      artist: "Sunomiya (CV: Sayumi Suzushiro)",
      artwork: "https://www.animu.moe//media/tracks/trackImage9126_large.jpg", // web base keeps its trailing slash (app parity)
      requestable: true,
    });
  });

  it("search rows obey the artwork quality — the same setting as now-playing", () => {
    const dto = MusicRequestResponseDTOSchema.parse(searchResponsePayload);
    // Row 2 carries every size: image_large/image_medium/image_tiny pairs
    // map to the CDN's size suffixes, so quality picks the same URL family
    // now-playing would pick for that track.
    const row: MusicRequestDTO = {
      id: 1,
      title: "Aegis of Love|Ijiranaide, Nagatoro-san 2nd Attack",
      author: "Sunomiya",
      image_large: "/media/tracks/trackImage9126_large.jpg",
      image_medium: "/media/tracks/trackImage9126_medium.jpg",
      image_tiny: "/media/tracks/trackImage9126_tiny.jpg",
      timestrike: "",
    };

    expect(musicRequestFromDTO(row, "high", DEFAULT_COVER).artwork).toBe(
      "https://www.animu.moe//media/tracks/trackImage9126_large.jpg",
    );
    expect(musicRequestFromDTO(row, "medium", DEFAULT_COVER).artwork).toBe(
      "https://www.animu.moe//media/tracks/trackImage9126_medium.jpg",
    );
    expect(musicRequestFromDTO(row, "low", DEFAULT_COVER).artwork).toBe(
      "https://www.animu.moe//media/tracks/trackImage9126_tiny.jpg",
    );
    // Quality off → no download anywhere, bundled/remote default instead
    expect(musicRequestFromDTO(row, "off", DEFAULT_COVER).artwork).toBe(DEFAULT_COVER);
  });

  it("quality falls back down the chain when only one size exists", () => {
    const dto = MusicRequestResponseDTOSchema.parse(searchResponsePayload);
    // Row 1 (Silversun) only carries image_tiny
    expect(musicRequestFromDTO(dto.objects[1]!, "high", DEFAULT_COVER).artwork).toBe(
      "https://www.animu.moe//media/tracks/trackImage9200_tiny.jpg",
    );

    // A row with no image at all always gets the default cover
    expect(musicRequestFromDTO({ id: 5, title: "X", author: "", timestrike: "" }, "high", DEFAULT_COVER).artwork).toBe(DEFAULT_COVER);
  });

  it("uses author fallback and flags timestrike as not requestable", () => {
    const dto = MusicRequestResponseDTOSchema.parse(searchResponsePayload);
    const second = musicRequestFromDTO(dto.objects[1]!, "high", DEFAULT_COVER);
    // No dash in the song part → the whole part becomes the artist (app parity)
    expect(second.artist).toBe("Silversun");
    expect(second.requestable).toBe(true);

    const third = musicRequestFromDTO(dto.objects[2]!, "high", DEFAULT_COVER);
    expect(third.requestable).toBe(false);
    expect(third.artwork).toBe(DEFAULT_COVER);
  });

  it("builds pagination with parsed next-page params", () => {
    const pagination = paginationFromDTO(searchResponsePayload, "high", DEFAULT_COVER);
    expect(pagination.totalResults).toBe(34);
    expect(pagination.totalPages).toBe(2);
    expect(pagination.nextPageParams).toEqual({
      server: 1,
      filter: "",
      query: "attack",
      requestable: false, // absent in the next URL → false (app parity)
      limit: 25,
      offset: 25,
    });
    expect(pagination.results).toHaveLength(3);
  });
});

describe("parseQueryParams", () => {
  it("parses all supported params with defaults", () => {
    expect(
      parseQueryParams("https://x.co/s?server=2&filter=anime&query=hikari&requestable=true&limit=10&offset=5"),
    ).toEqual({ server: 2, filter: "anime", query: "hikari", requestable: true, limit: 10, offset: 5 });
  });

  it("throws when there is no query string", () => {
    expect(() => parseQueryParams("https://x.co/noquery")).toThrow();
  });
});

describe("parseSubmissionResponse", () => {
  it("treats an empty response as success", () => {
    expect(parseSubmissionResponse("")).toEqual({ success: true });
  });

  it("maps erro=false to PANEL_UNAVAILABLE", () => {
    expect(parseSubmissionResponse('{"erro": "false"}')).toEqual({
      success: false,
      error: "PANEL_UNAVAILABLE",
    });
    expect(parseSubmissionResponse('{"erro": false}')).toMatchObject({ error: "PANEL_UNAVAILABLE" });
  });

  it("maps known blocks to upper-case codes with detail", () => {
    expect(parseSubmissionResponse('{"pediblock": "2026-09-03 14:00:00"}')).toEqual({
      success: false,
      error: "PEDIBLOCK",
      detail: "2026-09-03 14:00:00",
    });
    expect(parseSubmissionResponse('{"aniblock": "Naruto"}')).toMatchObject({ error: "ANIBLOCK" });
    expect(parseSubmissionResponse('{"artistblock": "LiSA"}')).toMatchObject({ error: "ARTISTBLOCK" });
    expect(parseSubmissionResponse('{"coverblock": "x"}')).toMatchObject({ error: "COVERBLOCK" });
  });

  it("passes through structured string errors", () => {
    expect(parseSubmissionResponse('{"erro": "NOLOGIN"}')).toEqual({
      success: false,
      error: "NOLOGIN",
    });
  });

  it("falls back to REQUEST_ERROR for unknown objects and echoes plain text", () => {
    expect(parseSubmissionResponse('{"weird": 1}')).toEqual({
      success: false,
      error: "REQUEST_ERROR",
    });
    expect(parseSubmissionResponse("plain php error")).toEqual({
      success: false,
      error: "plain php error",
    });
  });
});

describe("userFromExchangePayload", () => {
  it("maps the exchange payload to the User domain type", () => {
    const user = userFromExchangePayload(userExchangePayload);
    expect(user).toEqual({
      id: "1234567890",
      username: "harukinha",
      nickname: "Harukinha",
      avatar: "a1b2c3",
      avatarUrl: "https://cdn.discordapp.com/avatars/1234567890/a1b2c3.png",
      sessionId: "sess-abc123",
      mfa: true,
    });
  });

  it("throws ValidationError-shaped schema error on malformed payloads", () => {
    expect(() => userFromExchangePayload({ user: {} })).toThrow();
  });
});

describe("validateLiveRequest", () => {
  const valid = {
    name: "Haru",
    city: "São Paulo",
    artist: "LiSA",
    music: "Gurenge",
    anime: "Kimetsu no Yaiba",
  };

  it("accepts a complete request", () => {
    expect(validateLiveRequest(valid)).toEqual({ success: true });
  });

  it("rejects missing or blank fields with field-name messages", () => {
    expect(validateLiveRequest({ ...valid, name: "  " })).toMatchObject({
      success: false,
      message: "name is required",
    });
    expect(validateLiveRequest({ ...valid, city: "" }).success).toBe(false);
  });

  it("rejects fields over 100 chars and requests over 500", () => {
    expect(validateLiveRequest({ ...valid, name: "a".repeat(101) }).success).toBe(false);
    expect(validateLiveRequest({ ...valid, request: "b".repeat(501) }).success).toBe(false);
  });
});

describe("isRealTrack", () => {
  const makeTrack = (overrides: Partial<Track> = {}): Track => ({
    id: "1",
    raw: "Artist - Title",
    title: "Title",
    artist: "Artist",
    anime: "Naruto",
    artworks: {},
    artwork: "cover.jpg",
    duration: 60_000,
    isRequest: false,
    startTime: new Date(),
    playlistName: "",
    ...overrides,
  });

  it("accepts normal tracks", () => {
    expect(isRealTrack(makeTrack())).toBe(true);
  });

  it("filters jingles, idents and self-promo in any panel slot", () => {
    // Played-history jingle row (live payload sample)
    expect(
      isRealTrack(makeTrack({ raw: "Rádio Animu - Animesong? | Haruka VHT" })),
    ).toBe(false);
    // Transition row (requests-history sample)
    expect(
      isRealTrack(
        makeTrack({
          raw: "Rádio Animu - Nemukunai, a nossa comunidade sonora | Passagem Urahara",
        }),
      ),
    ).toBe(false);
    // Now-playing ident ("rádio animu" in the artist slot)
    expect(isRealTrack(makeTrack({ artist: "Rádio Animu" }))).toBe(false);
    // Transition named in the anime slot only
    expect(isRealTrack(makeTrack({ anime: "Passagem Musical" }))).toBe(false);
  });

  it("rejects missing tracks", () => {
    expect(isRealTrack(null)).toBe(false);
    expect(isRealTrack(undefined)).toBe(false);
  });
});

describe("getTrackProgress", () => {
  const NOW = 1_800_000_000_000;
  const makeTrack = (overrides: Partial<Track> = {}): Track => ({
    id: "1",
    raw: "Artist - Title",
    title: "Title",
    artist: "Artist",
    anime: "Naruto",
    artworks: {},
    artwork: "cover.jpg",
    duration: 60_000,
    isRequest: false,
    startTime: new Date(NOW - 5_000),
    playlistName: "",
    ...overrides,
  });

  it("returns elapsed ms for a running track", () => {
    expect(getTrackProgress(makeTrack(), NOW)).toBe(5_000);
  });

  it("returns null before the track starts", () => {
    expect(getTrackProgress(makeTrack({ startTime: new Date(NOW + 5_000) }), NOW)).toBeNull();
  });

  it("returns null after the track ended", () => {
    expect(
      getTrackProgress(
        makeTrack({ startTime: new Date(NOW - 61_000) }),
        NOW,
      ),
    ).toBeNull();
  });

  it("returns null for invalid durations and invalid/missing dates", () => {
    expect(getTrackProgress(makeTrack({ duration: 0 }), NOW)).toBeNull();
    expect(getTrackProgress(makeTrack({ duration: -1 }), NOW)).toBeNull();
    expect(getTrackProgress(makeTrack({ startTime: new Date(NaN) }), NOW)).toBeNull();
    expect(getTrackProgress(undefined, NOW)).toBeNull();
  });
});
