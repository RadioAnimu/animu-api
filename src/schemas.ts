import * as v from "valibot";

/**
 * Coercion helpers. The API has shipped numeric fields as strings, so
 * numbers are coerced at the boundary (equivalent to `z.coerce.number()` /
 * `z.coerce.boolean()`).
 */
const coerceNumber = v.pipe(v.unknown(), v.transform(Number), v.number());
const coerceBoolean = v.pipe(v.unknown(), v.transform(Boolean), v.boolean());

/**
 * Now-playing payload from the API base URL.
 *
 * `track` is optional: payloads without track data degrade to a null track.
 */
const TrackObjectSchema = v.object({
  artist: v.optional(v.string()),
  title: v.optional(v.string()),
  album: v.optional(v.string()),
  duration: coerceNumber,
  timestart: coerceNumber,
  artworks: v.optional(
    v.object({
      tiny: v.optional(v.string()),
      medium: v.optional(v.string()),
      large: v.optional(v.string()),
    }),
  ),
  playlist: v.optional(
    v.object({
      track_id: coerceNumber,
      title: v.optional(v.string()),
    }),
  ),
});

export const TrackDTOSchema = v.object({
  rawtitle: v.optional(v.string()),
  track: v.optional(TrackObjectSchema),
});

/**
 * Listener count fields. The field name varies between endpoints/versions —
 * all known aliases are accepted and coerced (the API has sent strings).
 */
export const ListenersDTOSchema = v.object({
  listeners: v.optional(coerceNumber),
  currentListeners: v.optional(coerceNumber),
  active_listeners: v.optional(coerceNumber),
  total: v.optional(coerceNumber),
});

/** Combined schema for the BASE_URL payload (track info + listener count). */
export const StreamMetadataDTOSchema = v.object({
  ...TrackDTOSchema.entries,
  ...ListenersDTOSchema.entries,
});

/**
 * `song_change` event from the realtime SSE stream. Same shape as
 * {@link StreamMetadataDTOSchema} plus the station's `server_name` and
 * `status` (`"autodj"`, `"live"` or `"offline"`).
 *
 * The Go daemon also reports `offline_since` / `message` while offline, and
 * its duration can be the literal string `"notime"` (no length was resolved)
 * — that case degrades to `0` instead of failing the whole event.
 */
export const LiveSongChangeDTOSchema = v.object({
  ...StreamMetadataDTOSchema.entries,
  track: v.optional(
    v.object({
      ...TrackObjectSchema.entries,
      duration: v.fallback(coerceNumber, 0),
    }),
  ),
  server_name: v.optional(v.string()),
  status: v.optional(v.string()),
  offline_since: v.optional(v.string()),
  message: v.optional(v.string()),
});

/** `listeners` event from the realtime SSE stream. */
export const LiveListenersDTOSchema = v.object({
  listeners: coerceNumber,
});

/** PHP page endpoint — every field degrades to "" instead of failing. */
export const ProgramDTOSchema = v.object({
  locutor: v.fallback(v.string(), ""),
  programa: v.fallback(v.string(), ""),
  pedidos_ao_vivo: v.fallback(v.string(), ""),
  imagem: v.fallback(v.string(), ""),
  infoPrograma: v.fallback(v.string(), ""),
  temaPrograma: v.fallback(v.string(), ""),
});

/**
 * History endpoints return positional PHP arrays:
 *   played:   [title, coverUrl]
 *   requests: [title, HH:MM:SS, requestId?, coverUrl?]
 * Trailing entries are a loose union. A row that isn't an array with at
 * least two string entries fails the whole payload (consumers degrade to []).
 */
export const TrackHistoryItemSchema = v.pipe(
  v.looseTuple([v.string(), v.string()]),
  v.check(
    (row) =>
      row
        .slice(2)
        .every((entry) => typeof entry === "string" || typeof entry === "number"),
    "Trailing history entries must be strings or numbers",
  ),
);

/** Array of history rows; validated with {@link TrackHistoryItemSchema}. */
export const TrackHistorySchema = v.array(TrackHistoryItemSchema);

/** One row of the request-search database. `timestrike` marks blocked tracks. */
export const MusicRequestDTOSchema = v.object({
  id: coerceNumber,
  title: v.string(),
  author: v.fallback(v.string(), ""),
  image_large: v.optional(v.string()),
  image_medium: v.optional(v.string()),
  image_tiny: v.optional(v.string()),
  timestrike: v.optional(v.string()),
});

/** Paginated request-search response (Tastypie-style envelope). */
export const MusicRequestResponseDTOSchema = v.object({
  meta: v.object({
    limit: coerceNumber,
    next: v.nullable(v.string()),
    offset: coerceNumber,
    previous: v.nullable(v.string()),
    total_count: coerceNumber,
  }),
  objects: v.array(MusicRequestDTOSchema),
});

/** One audio stream from the stream list endpoint. */
export const StreamDTOSchema = v.object({
  id: v.string(),
  bitrate: coerceNumber,
  category: v.string(),
  url: v.string(),
});

/** Stream list — must contain at least one relay to be trusted. */
export const StreamListDTOSchema = v.pipe(v.array(StreamDTOSchema), v.nonEmpty());

/** Discord user payload returned by the token-exchange endpoint. */
export const UserDTOSchema = v.object({
  id: v.string(),
  username: v.string(),
  nickname: v.string(),
  avatar: v.string(),
  avatar_url: v.string(),
  PHPSESSID: v.string(),
  mfa: coerceBoolean,
  avatar_decoration_data: v.optional(v.unknown()),
});

export type TrackDTO = v.InferOutput<typeof TrackDTOSchema>;
export type ListenersDTO = v.InferOutput<typeof ListenersDTOSchema>;
export type StreamMetadataDTO = v.InferOutput<typeof StreamMetadataDTOSchema>;
export type LiveSongChangeDTO = v.InferOutput<typeof LiveSongChangeDTOSchema>;
export type LiveListenersDTO = v.InferOutput<typeof LiveListenersDTOSchema>;
export type ProgramDTO = v.InferOutput<typeof ProgramDTOSchema>;
export type TrackHistoryItemDTO = v.InferOutput<typeof TrackHistoryItemSchema>;
export type TrackHistoryDTO = v.InferOutput<typeof TrackHistorySchema>;
export type MusicRequestDTO = v.InferOutput<typeof MusicRequestDTOSchema>;
export type MusicRequestResponseDTO = v.InferOutput<
  typeof MusicRequestResponseDTOSchema
>;
export type StreamDTO = v.InferOutput<typeof StreamDTOSchema>;
export type UserDTO = v.InferOutput<typeof UserDTOSchema>;
