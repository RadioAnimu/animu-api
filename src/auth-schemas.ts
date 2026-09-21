import * as v from "valibot";

/**
 * Coercion helpers matching the API's loose typing (numbers/booleans/ids
 * have all been observed as strings).
 */
const coerceNumber = v.pipe(v.unknown(), v.transform(Number), v.number());
const coerceBoolean = v.pipe(v.unknown(), v.transform(Boolean), v.boolean());
const coerceString = v.pipe(v.unknown(), v.transform(String), v.string());

/**
 * Animu Auth API (v5) response envelopes.
 *
 * Success: `{ "ok": true, "data": { ... } }`
 * Failure: `{ "ok": false, "error": { "code", "message" } }`
 *
 * The failure envelope is parsed by the HTTP layer (see `errorFromResponse`),
 * so `AnimuAuth` only validates the success branch here.
 */
export function apiEnvelopeSchema<T extends v.GenericSchema>(data: T) {
  return v.object({ ok: v.literal(true), data });
}

/** Validates a success envelope and returns its `data` with the schema's type. */
export function unwrapEnvelope<T extends v.GenericSchema>(
  schema: T,
  payload: unknown,
): v.InferOutput<T> {
  const parsed = v.parse(apiEnvelopeSchema(schema), payload) as {
    data: v.InferOutput<T>;
  };
  return parsed.data;
}

/** The `error` object inside a failure envelope. */
export const ApiErrorDTOSchema = v.object({
  code: v.fallback(v.string(), "unknown"),
  message: v.fallback(v.string(), ""),
});

/** Full failure envelope, exported for consumers who parse raw responses. */
export const ApiErrorEnvelopeDTOSchema = v.object({
  ok: v.literal(false),
  error: ApiErrorDTOSchema,
});

/**
 * User projection shared by every v5 endpoint. Shapes differ slightly
 * between endpoints (login omits `handle`/`avatar_custom`; refresh drops
 * `verified`/`handle` from `user`), so missing fields degrade to
 * `null`/`false` instead of failing validation.
 */
export const AuthUserDTOSchema = v.object({
  id: coerceNumber,
  username: v.string(),
  handle: v.fallback(v.nullable(v.string()), null),
  email: v.fallback(v.nullable(v.string()), null),
  avatar_url: v.fallback(v.nullable(v.string()), null),
  avatar_custom: v.fallback(coerceBoolean, false),
  verified: v.fallback(coerceBoolean, false),
  created_at: v.fallback(v.nullable(v.string()), null),
});

/** One configured login provider. */
export const ProviderDTOSchema = v.object({
  name: v.string(),
  label: v.string(),
});

/** `GET /api/v5/providers.php` */
export const ProviderListDTOSchema = v.object({
  providers: v.array(ProviderDTOSchema),
});

/**
 * `POST /api/v5/auth/exchange-token.php`, `POST /api/v5/auth/email/verify.php`
 * and `POST /api/v5/me/emails/verify.php`-style session/`user` payloads.
 */
export const AuthSessionDTOSchema = v.object({
  session_token: v.string(),
  action: v.fallback(v.string(), "login"),
  user: AuthUserDTOSchema,
});

/** `GET /api/v5/auth/session-status.php` */
export const AuthSessionStatusDTOSchema = v.object({
  authenticated: v.fallback(coerceBoolean, false),
  session_token: v.fallback(v.string(), ""),
});

/** `POST /api/v5/auth/logout.php` */
export const AuthLogoutDTOSchema = v.object({
  logged_out: v.fallback(coerceBoolean, false),
});

/** A linked provider identity. */
export const LinkedProviderDTOSchema = v.object({
  provider: v.string(),
  provider_user_id: v.string(),
  provider_email: v.fallback(v.nullable(v.string()), null),
  // Optional: the server only has these for some providers (Discord @username,
  // Google display name). Tolerate their absence on older payloads.
  provider_username: v.fallback(v.nullish(v.string()), null),
  provider_name: v.fallback(v.nullish(v.string()), null),
});

const BannerDTOSchema = v.object({
  url: v.fallback(v.nullable(v.string()), null),
  color: v.fallback(v.nullable(v.string()), null),
});

const SessionInfoDTOSchema = v.object({
  session_id: v.fallback(v.string(), ""),
  login_provider: v.fallback(v.nullable(v.string()), null),
  last_activity: v.fallback(coerceNumber, 0),
});

const ProfileLinksDTOSchema = v.object({
  avatar: v.fallback(v.string(), ""),
  browser_login: v.fallback(v.string(), ""),
});

/** `GET /api/v5/me/profile.php` */
export const AuthProfileDTOSchema = v.object({
  user: AuthUserDTOSchema,
  banner: BannerDTOSchema,
  linked_providers: v.fallback(v.array(LinkedProviderDTOSchema), []),
  available_providers: v.fallback(v.array(ProviderDTOSchema), []),
  session: SessionInfoDTOSchema,
  links: ProfileLinksDTOSchema,
});

/** `POST /api/v5/me/refresh.php` */
export const AuthRefreshDTOSchema = v.object({
  updated: v.fallback(coerceBoolean, false),
  verified: v.fallback(coerceBoolean, false),
  user: AuthUserDTOSchema,
});

/**
 * `POST /api/v5/auth/email/request.php` and `POST /api/v5/me/emails.php`
 * (add-email step 1): always answers generically `{ sent: true }`.
 */
export const AuthEmailSentDTOSchema = v.object({
  sent: v.fallback(coerceBoolean, false),
});

/** One entry of the account's Animu Connect email list. */
export const AuthEmailDTOSchema = v.object({
  id: coerceNumber,
  email: v.string(),
  source: v.fallback(v.string(), "provider"),
  provider: v.fallback(v.nullable(v.string()), null),
  verified: v.fallback(coerceBoolean, false),
  removable: v.fallback(coerceBoolean, false),
});

/** `GET|POST|DELETE /api/v5/me/emails.php` and `POST /api/v5/me/emails/verify.php` */
export const AuthEmailsDTOSchema = v.object({
  emails: v.fallback(v.array(AuthEmailDTOSchema), []),
});

/** `POST`/`DELETE /api/v5/me/emails.php` (DELETE adds `removed`). */
export const AuthEmailRemoveDTOSchema = v.object({
  ...AuthEmailsDTOSchema.entries,
  removed: v.fallback(coerceBoolean, false),
});

/** `POST /api/v5/me/link.php` */
export const AuthLinkDTOSchema = v.object({
  action: v.fallback(v.string(), "linked"),
  provider: v.string(),
  user: AuthUserDTOSchema,
  linked_providers: v.fallback(v.array(LinkedProviderDTOSchema), []),
});

/** `POST /api/v5/me/unlink.php` */
export const AuthUnlinkDTOSchema = v.object({
  unlinked: v.fallback(coerceBoolean, false),
  provider: v.string(),
  needs_setup: v.fallback(coerceBoolean, false),
  linked_providers: v.fallback(v.array(LinkedProviderDTOSchema), []),
});

/** `POST` / `DELETE /api/v5/me/avatar.php` */
export const AuthAvatarDTOSchema = v.object({
  avatar_url: v.fallback(v.nullable(v.string()), null),
});

/** `DELETE /api/v5/me/account.php` */
export const AuthDeleteDTOSchema = v.object({
  deleted: v.fallback(coerceBoolean, false),
});

/**
 * Legacy `/mobile/exchange-token.php` payload (no `{ok, data}` envelope).
 * On failure the endpoint returns `{ error, message? }` at HTTP 200 — the
 * client inspects `error` before validating this schema.
 */
export const LegacyMobileSessionDTOSchema = v.object({
  user: v.fallback(
    v.nullable(
      v.object({
        username: v.fallback(v.string(), ""),
        id: v.fallback(coerceString, ""),
        avatar: v.fallback(v.string(), ""),
        mfa: v.fallback(coerceBoolean, false),
        avatar_url: v.fallback(v.string(), ""),
        nickname: v.fallback(v.string(), ""),
        avatar_decoration_data: v.optional(v.unknown()),
      }),
    ),
    null,
  ),
  PHPSESSID: v.string(),
  action: v.fallback(v.string(), "login"),
});

export type AuthUserDTO = v.InferOutput<typeof AuthUserDTOSchema>;
export type ProviderDTO = v.InferOutput<typeof ProviderDTOSchema>;
export type AuthSessionDTO = v.InferOutput<typeof AuthSessionDTOSchema>;
export type AuthSessionStatusDTO = v.InferOutput<
  typeof AuthSessionStatusDTOSchema
>;
export type LinkedProviderDTO = v.InferOutput<typeof LinkedProviderDTOSchema>;
export type AuthProfileDTO = v.InferOutput<typeof AuthProfileDTOSchema>;
export type AuthRefreshDTO = v.InferOutput<typeof AuthRefreshDTOSchema>;
export type AuthEmailSentDTO = v.InferOutput<typeof AuthEmailSentDTOSchema>;
export type AuthEmailDTO = v.InferOutput<typeof AuthEmailDTOSchema>;
export type AuthEmailsDTO = v.InferOutput<typeof AuthEmailsDTOSchema>;
export type AuthEmailRemoveDTO = v.InferOutput<typeof AuthEmailRemoveDTOSchema>;
export type AuthLinkDTO = v.InferOutput<typeof AuthLinkDTOSchema>;
export type AuthUnlinkDTO = v.InferOutput<typeof AuthUnlinkDTOSchema>;
export type AuthAvatarDTO = v.InferOutput<typeof AuthAvatarDTOSchema>;
export type LegacyMobileSessionDTO = v.InferOutput<
  typeof LegacyMobileSessionDTOSchema
>;
