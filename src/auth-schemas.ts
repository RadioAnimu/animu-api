import { z } from "zod";

/**
 * Animu Auth API (v5) response envelopes.
 *
 * Success: `{ "ok": true, "data": { ... } }`
 * Failure: `{ "ok": false, "error": { "code", "message" } }`
 *
 * The failure envelope is parsed by the HTTP layer (see `errorFromResponse`),
 * so `AnimuAuth` only validates the success branch here.
 */
export function apiEnvelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({ ok: z.literal(true), data });
}

/** Validates a success envelope and returns its `data` with the schema's type. */
export function unwrapEnvelope<T extends z.ZodTypeAny>(
  schema: T,
  payload: unknown,
): z.infer<T> {
  const parsed = apiEnvelopeSchema(schema).parse(payload) as {
    data: z.infer<T>;
  };
  return parsed.data;
}

/** The `error` object inside a failure envelope. */
export const ApiErrorDTOSchema = z.object({
  code: z.string().catch("unknown"),
  message: z.string().catch(""),
});

/** Full failure envelope, exported for consumers who parse raw responses. */
export const ApiErrorEnvelopeDTOSchema = z.object({
  ok: z.literal(false),
  error: ApiErrorDTOSchema,
});

/**
 * User projection shared by every v5 endpoint. Shapes differ slightly
 * between endpoints (login omits `handle`/`avatar_custom`; refresh drops
 * `verified`/`handle` from `user`), so missing fields degrade to
 * `null`/`false` instead of failing validation.
 */
export const AuthUserDTOSchema = z.object({
  id: z.coerce.number(),
  username: z.string(),
  handle: z.string().nullable().catch(null),
  email: z.string().nullable().catch(null),
  avatar_url: z.string().nullable().catch(null),
  avatar_custom: z.coerce.boolean().catch(false),
  verified: z.coerce.boolean().catch(false),
  created_at: z.string().nullable().catch(null),
});

/** One configured login provider. */
export const ProviderDTOSchema = z.object({
  name: z.string(),
  label: z.string(),
});

/** `GET /api/v5/providers.php` */
export const ProviderListDTOSchema = z.object({
  providers: z.array(ProviderDTOSchema),
});

/**
 * `POST /api/v5/auth/exchange-token.php`, `POST /api/v5/auth/email/verify.php`
 * and `POST /api/v5/me/emails/verify.php`-style session/`user` payloads.
 */
export const AuthSessionDTOSchema = z.object({
  session_token: z.string(),
  action: z.string().catch("login"),
  user: AuthUserDTOSchema,
});

/** `GET /api/v5/auth/session-status.php` */
export const AuthSessionStatusDTOSchema = z.object({
  authenticated: z.coerce.boolean().catch(false),
  session_token: z.string().catch(""),
});

/** `POST /api/v5/auth/logout.php` */
export const AuthLogoutDTOSchema = z.object({
  logged_out: z.coerce.boolean().catch(false),
});

/** A linked provider identity. */
export const LinkedProviderDTOSchema = z.object({
  provider: z.string(),
  provider_user_id: z.string(),
  provider_email: z.string().nullable().catch(null),
  // Optional: the server only has these for some providers (Discord @username,
  // Google display name). Tolerate their absence on older payloads.
  provider_username: z.string().nullish().catch(null),
  provider_name: z.string().nullish().catch(null),
});

const BannerDTOSchema = z.object({
  url: z.string().nullable().catch(null),
  color: z.string().nullable().catch(null),
});

const SessionInfoDTOSchema = z.object({
  session_id: z.string().catch(""),
  login_provider: z.string().nullable().catch(null),
  last_activity: z.coerce.number().catch(0),
});

const ProfileLinksDTOSchema = z.object({
  avatar: z.string().catch(""),
  browser_login: z.string().catch(""),
});

/** `GET /api/v5/me/profile.php` */
export const AuthProfileDTOSchema = z.object({
  user: AuthUserDTOSchema,
  banner: BannerDTOSchema,
  linked_providers: z.array(LinkedProviderDTOSchema).catch([]),
  available_providers: z.array(ProviderDTOSchema).catch([]),
  session: SessionInfoDTOSchema,
  links: ProfileLinksDTOSchema,
});

/** `POST /api/v5/me/refresh.php` */
export const AuthRefreshDTOSchema = z.object({
  updated: z.coerce.boolean().catch(false),
  verified: z.coerce.boolean().catch(false),
  user: AuthUserDTOSchema,
});

/**
 * `POST /api/v5/auth/email/request.php` and `POST /api/v5/me/emails.php`
 * (add-email step 1): always answers generically `{ sent: true }`.
 */
export const AuthEmailSentDTOSchema = z.object({
  sent: z.coerce.boolean().catch(false),
});

/** One entry of the account's Animu Connect email list. */
export const AuthEmailDTOSchema = z.object({
  id: z.coerce.number(),
  email: z.string(),
  source: z.string().catch("provider"),
  provider: z.string().nullable().catch(null),
  verified: z.coerce.boolean().catch(false),
  removable: z.coerce.boolean().catch(false),
});

/** `GET|POST|DELETE /api/v5/me/emails.php` and `POST /api/v5/me/emails/verify.php` */
export const AuthEmailsDTOSchema = z.object({
  emails: z.array(AuthEmailDTOSchema).catch([]),
});

/** `POST`/`DELETE /api/v5/me/emails.php` (DELETE adds `removed`). */
export const AuthEmailRemoveDTOSchema = AuthEmailsDTOSchema.extend({
  removed: z.coerce.boolean().catch(false),
});

/** `POST /api/v5/me/link.php` */
export const AuthLinkDTOSchema = z.object({
  action: z.string().catch("linked"),
  provider: z.string(),
  user: AuthUserDTOSchema,
  linked_providers: z.array(LinkedProviderDTOSchema).catch([]),
});

/** `POST /api/v5/me/unlink.php` */
export const AuthUnlinkDTOSchema = z.object({
  unlinked: z.coerce.boolean().catch(false),
  provider: z.string(),
  needs_setup: z.coerce.boolean().catch(false),
  linked_providers: z.array(LinkedProviderDTOSchema).catch([]),
});

/** `POST` / `DELETE /api/v5/me/avatar.php` */
export const AuthAvatarDTOSchema = z.object({
  avatar_url: z.string().nullable().catch(null),
});

/** `DELETE /api/v5/me/account.php` */
export const AuthDeleteDTOSchema = z.object({
  deleted: z.coerce.boolean().catch(false),
});

/**
 * Legacy `/mobile/exchange-token.php` payload (no `{ok, data}` envelope).
 * On failure the endpoint returns `{ error, message? }` at HTTP 200 — the
 * client inspects `error` before validating this schema.
 */
export const LegacyMobileSessionDTOSchema = z.object({
  user: z
    .object({
      username: z.string().catch(""),
      id: z.coerce.string().catch(""),
      avatar: z.string().catch(""),
      mfa: z.coerce.boolean().catch(false),
      avatar_url: z.string().catch(""),
      nickname: z.string().catch(""),
      avatar_decoration_data: z.unknown().optional(),
    })
    .nullable()
    .catch(null),
  PHPSESSID: z.string(),
  action: z.string().catch("login"),
});

export type AuthUserDTO = z.infer<typeof AuthUserDTOSchema>;
export type ProviderDTO = z.infer<typeof ProviderDTOSchema>;
export type AuthSessionDTO = z.infer<typeof AuthSessionDTOSchema>;
export type AuthSessionStatusDTO = z.infer<typeof AuthSessionStatusDTOSchema>;
export type LinkedProviderDTO = z.infer<typeof LinkedProviderDTOSchema>;
export type AuthProfileDTO = z.infer<typeof AuthProfileDTOSchema>;
export type AuthRefreshDTO = z.infer<typeof AuthRefreshDTOSchema>;
export type AuthEmailSentDTO = z.infer<typeof AuthEmailSentDTOSchema>;
export type AuthEmailDTO = z.infer<typeof AuthEmailDTOSchema>;
export type AuthEmailsDTO = z.infer<typeof AuthEmailsDTOSchema>;
export type AuthEmailRemoveDTO = z.infer<typeof AuthEmailRemoveDTOSchema>;
export type AuthLinkDTO = z.infer<typeof AuthLinkDTOSchema>;
export type AuthUnlinkDTO = z.infer<typeof AuthUnlinkDTOSchema>;
export type AuthAvatarDTO = z.infer<typeof AuthAvatarDTOSchema>;
export type LegacyMobileSessionDTO = z.infer<
  typeof LegacyMobileSessionDTOSchema
>;
