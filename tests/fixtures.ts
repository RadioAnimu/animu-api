/**
 * Mock payloads mirroring the real API shapes, including the server's
 * quirks (numeric fields as strings, listener-count aliases, positional
 * history arrays, broken program fields).
 */

export const metadataPayload = {
  rawtitle: "Runa Mizutani - Philosophyz  | Re︰Change ～Rewrite EDM Arrange Album～",
  track: {
    artist: "Runa Mizutani",
    title: "Philosophyz",
    duration: "264000",
    timestart: "1788408452000",
    artworks: {
      tiny: "https://www.animu.moe/media/tracks/trackImage16217_tiny.jpg",
      medium: "https://www.animu.moe/media/tracks/trackImage16217_medium.jpg",
      large: "https://www.animu.moe/media/tracks/trackImage16217_large.jpg",
    },
    playlist: { track_id: "16217" },
  },
  listeners: "21",
};

export const metadataPayloadWithAlias = {
  rawtitle: "Yuki Kajiura - track of twilight | .hack//SIGN",
  track: {
    duration: 200000,
    timestart: 1788408600000,
  },
  currentListeners: 7,
};

export const metadataPayloadWithoutTrack = {
  listeners: 3,
};

export const liveSongChangePayload = {
  server_name: "Animu FM Radio Station - The Most Moe Radio of Brazil!",
  status: "autodj",
  rawtitle: "Kikuo feat. Hatsune Miku - Kimi wa Dekinai Ko",
  listeners: 22,
  track: {
    artist: "Kikuo feat. Hatsune Miku",
    title: "Kimi wa Dekinai Ko",
    album: "きくおミク3",
    artworks: {
      tiny: "https://www.animu.moe/media/tracks/trackImage9502.jpg",
      medium: "https://www.animu.moe/media/tracks/trackImage9502_medium.jpg",
      large: "https://www.animu.moe/media/tracks/trackImage9502_large.jpg",
    },
    timestart: 1789583335000,
    duration: 262600,
    playlist: { track_id: 9502, title: "Animu Toca" },
  },
};

export const liveListenersPayload = { listeners: 25 };

/** Mirrors the Go daemon's `buildOfflinePayload` (station down). */
export const liveSongChangeOfflinePayload = {
  server_name: "Animu FM Radio Station - The Most Moe Radio of Brazil!",
  status: "offline",
  offline_since: "2026-09-16T18:00:00Z",
  message: "Servidor temporariamente offline — voltamos em breve!",
  rawtitle: "Rádio Animu - Offline | Voltamos já!",
  listeners: 0,
  track: {
    artist: "Rádio Animu",
    title: "Offline — Voltamos já!",
    album: "Animu Offline",
    artworks: { tiny: "https://www.animu.moe/nocover.png", medium: "https://www.animu.moe/nocover.png", large: "https://www.animu.moe/nocover.png" },
    timestart: 0,
    duration: 0,
  },
};

/** The daemon reports `"notime"` when no track length was resolved. */
export const liveSongChangeNoTimePayload = {
  ...liveSongChangePayload,
  rawtitle: "DJ Haruka - Live Set [NO AR]",
  track: { ...liveSongChangePayload.track, duration: "notime", album: "" },
};

export const programPayload = {
  locutor: "Dolode",
  programa: "Natsukashii",
  pedidos_ao_vivo: "yes",
  imagem: "https://www.animu.moe/wp-content/uploads/2023/08/Logo-Natsukashii.webp",
  infoPrograma: "Nostalgia pura.",
  temaPrograma: "Clássicas",
};

export const programPayloadAutoDJ = {
  locutor: "Haruka Yuki",
  programa: "Animu NON-STOP",
  pedidos_ao_vivo: "no",
  imagem: "",
  infoPrograma: "",
  temaPrograma: "",
};

export const programPayloadMalformed = {
  locutor: 42,
  programa: null,
  imagem: undefined,
};

export const playedHistoryPayload = [
  ["Kana Hanazawa - Renai Circulation | Bakemonogatari", "https://www.animu.moe/media/tracks/cover.jpg"],
  ["LiSA - crossing field | Sword Art Online", "https://www.animu.moe/media/tracks/cover2.jpg"],
  ["animu - jingle", "https://www.animu.moe/jingle.jpg"],
];

export const requestsHistoryPayload = [
  ["Yui - Again | FMA Brotherhood", "14:32:05", "9126", "https://www.animu.moe/media/tracks/req.jpg"],
  ["Aimer - Brave Shine | Fate/stay night", "13:58:41", "9200", "https://www.animu.moe/media/tracks/req2.jpg"],
  ["animu - ident", "13:00:00", "9000", "https://www.animu.moe/ident.jpg"],
];

export const searchResponsePayload = {
  meta: {
    limit: "25",
    next: "/teste/requestSearchTest.php?server=1&query=attack&limit=25&offset=25",
    offset: "0",
    previous: null,
    total_count: "34",
  },
  objects: [
    {
      id: "9126",
      title: "Aegis of Love|Ijiranaide, Nagatoro-san 2nd Attack",
      author: "Sunomiya (CV: Sayumi Suzushiro)",
      image_large: "/media/tracks/trackImage9126_large.jpg",
      timestrike: "",
    },
    {
      id: 9200,
      title: "Silversun|Blue Gender",
      author: "",
      image_tiny: "/media/tracks/trackImage9200_tiny.jpg",
    },
    {
      id: "9300",
      title: "No-Artist|Unknown Anime",
      timestrike: "2026-09-03 12:00:00",
    },
  ],
};

export const streamsPayload = [
  { id: "320", bitrate: "320", category: "MP3", url: "https://stream.animu.moe/320" },
  { id: "192", bitrate: 192, category: "MP3", url: "https://stream.animu.moe/192" },
];

export const userExchangePayload = {
  user: {
    id: "1234567890",
    username: "harukinha",
    nickname: "Harukinha",
    avatar: "a1b2c3",
    avatar_url: "https://cdn.discordapp.com/avatars/1234567890/a1b2c3.png",
    mfa: "true",
    avatar_decoration_data: { asset: "x" },
  },
  PHPSESSID: "sess-abc123",
};
