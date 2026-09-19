import type {
  AuthEmailDTO,
  AuthEmailRemoveDTO,
  AuthEmailSentDTO,
  AuthEmailsDTO,
  AuthLinkDTO,
  AuthProfileDTO,
  AuthRefreshDTO,
  AuthSessionDTO,
  AuthSessionStatusDTO,
  AuthUnlinkDTO,
  AuthUserDTO,
  LegacyMobileSessionDTO,
  LinkedProviderDTO,
  ProviderDTO,
} from "./auth-schemas.js";
import type {
  AuthBanner,
  AuthAccountEmail,
  AuthEmailsResult,
  AuthEmailRequestResult,
  AuthRemoveEmailResult,
  AuthLinkResult,
  AuthProfile,
  AuthRefreshResult,
  AuthSession,
  AuthSessionStatus,
  AuthUnlinkResult,
  AuthUser,
  LegacyMobileSession,
  LinkedProvider,
  MobileAuthRedirect,
  ProviderInfo,
} from "./auth-types.js";

/** Resolves relative API paths (`api/v5/me/avatar.php`) against the auth base. */
function resolveUrl(baseUrl: string, url: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

/**
 * Maps the shared user projection to an {@link AuthUser}, resolving relative
 * avatar paths against the auth base.
 */
export function authUserFromDTO(dto: AuthUserDTO, baseUrl: string): AuthUser {
  return {
    id: dto.id,
    username: dto.username,
    handle: dto.handle,
    email: dto.email,
    avatarUrl: resolveUrl(baseUrl, dto.avatar_url),
    avatarCustom: dto.avatar_custom,
    verified: dto.verified,
    createdAt: dto.created_at,
  };
}

/** Maps a login result (`exchangeToken` / `nativeLogin`). */
export function authSessionFromDTO(
  dto: AuthSessionDTO,
  baseUrl: string,
): AuthSession {
  return {
    sessionToken: dto.session_token,
    action: dto.action,
    user: authUserFromDTO(dto.user, baseUrl),
  };
}

/** Maps a provider list payload. */
export function providerListFromDTO(data: {
  providers: ProviderDTO[];
}): ProviderInfo[] {
  return data.providers.map((p) => ({ name: p.name, label: p.label }));
}

/** Maps a session-status payload. */
export function sessionStatusFromDTO(
  dto: AuthSessionStatusDTO,
): AuthSessionStatus {
  return {
    authenticated: dto.authenticated,
    sessionToken: dto.session_token,
  };
}

/** Maps a linked-provider DTO. */
export function linkedProviderFromDTO(dto: LinkedProviderDTO): LinkedProvider {
  return {
    provider: dto.provider,
    providerUserId: dto.provider_user_id,
    providerEmail: dto.provider_email,
    providerUsername: dto.provider_username ?? null,
    providerName: dto.provider_name ?? null,
  };
}

/** Maps a banner DTO, resolving a relative banner URL against the auth base. */
export function bannerFromDTO(
  dto: AuthProfileDTO["banner"],
  baseUrl: string,
): AuthBanner {
  return { url: resolveUrl(baseUrl, dto.url), color: dto.color };
}

/** Maps the full profile payload. */
export function authProfileFromDTO(
  dto: AuthProfileDTO,
  baseUrl: string,
): AuthProfile {
  return {
    user: authUserFromDTO(dto.user, baseUrl),
    banner: bannerFromDTO(dto.banner, baseUrl),
    linkedProviders: dto.linked_providers.map(linkedProviderFromDTO),
    availableProviders: dto.available_providers.map((p) => ({
      name: p.name,
      label: p.label,
    })),
    session: {
      sessionId: dto.session.session_id,
      loginProvider: dto.session.login_provider,
      lastActivity: dto.session.last_activity,
    },
    links: {
      avatar: resolveUrl(baseUrl, dto.links.avatar) ?? "",
      browserLogin: resolveUrl(baseUrl, dto.links.browser_login) ?? "",
    },
  };
}

/**
 * Maps a refresh payload. The top-level `verified` is authoritative (the
 * `user` object omits it on this endpoint), so it is copied onto the user.
 */
export function authRefreshFromDTO(
  dto: AuthRefreshDTO,
  baseUrl: string,
): AuthRefreshResult {
  const user = authUserFromDTO(dto.user, baseUrl);
  return {
    updated: dto.updated,
    verified: dto.verified,
    user: { ...user, verified: dto.verified },
  };
}

/** Maps a generic `{ sent }` result (login-code / add-email requests). */
export function authEmailSentFromDTO(dto: AuthEmailSentDTO): AuthEmailRequestResult {
  return { sent: dto.sent };
}

/** Maps an Animu Connect email list entry. */
export function authEmailFromDTO(dto: AuthEmailDTO): AuthAccountEmail {
  return {
    id: dto.id,
    email: dto.email,
    source: dto.source,
    provider: dto.provider,
    verified: dto.verified,
    removable: dto.removable,
  };
}

/** Maps an Animu Connect email list payload. */
export function authEmailsFromDTO(dto: AuthEmailsDTO): AuthEmailsResult {
  return { emails: dto.emails.map(authEmailFromDTO) };
}

/** Maps the remove-extra-email payload. */
export function authRemoveEmailFromDTO(dto: AuthEmailRemoveDTO): AuthRemoveEmailResult {
  return { removed: dto.removed, emails: dto.emails.map(authEmailFromDTO) };
}

/** Maps a provider-link payload. */
export function authLinkFromDTO(
  dto: AuthLinkDTO,
  baseUrl: string,
): AuthLinkResult {
  return {
    action: dto.action,
    provider: dto.provider,
    user: authUserFromDTO(dto.user, baseUrl),
    linkedProviders: dto.linked_providers.map(linkedProviderFromDTO),
  };
}

/** Maps a provider-unlink payload. */
export function authUnlinkFromDTO(dto: AuthUnlinkDTO): AuthUnlinkResult {
  return {
    unlinked: dto.unlinked,
    provider: dto.provider,
    needsSetup: dto.needs_setup,
    linkedProviders: dto.linked_providers.map(linkedProviderFromDTO),
  };
}

/** Resolves the `avatar_url` returned by the avatar upload/reset endpoints. */
export function avatarUrlFromDTO(
  dto: { avatar_url: string | null },
  baseUrl: string,
): string | null {
  return resolveUrl(baseUrl, dto.avatar_url);
}

/** Maps the legacy `/mobile/exchange-token.php` payload. */
export function legacyMobileSessionFromDTO(
  dto: LegacyMobileSessionDTO,
): LegacyMobileSession {
  return {
    user:
      dto.user === null
        ? null
        : {
            username: dto.user.username,
            id: dto.user.id,
            avatar: dto.user.avatar,
            mfa: dto.user.mfa,
            avatarUrl: dto.user.avatar_url,
            nickname: dto.user.nickname,
            avatarDecorationData: dto.user.avatar_decoration_data ?? null,
          },
    sessionToken: dto.PHPSESSID,
    action: dto.action,
  };
}

/**
 * Parses the deep link the server bounces after **server-side mobile auth**
 * (`/mobile/google-start.php` or `/mobile/apple-start.php`). Accepts the full
 * URL or just its query string, and is tolerant of custom schemes
 * (e.g. `animuapp://redirect?token=…`).
 */
export function parseMobileAuthRedirect(url: string): MobileAuthRedirect {
  const queryIndex = url.indexOf("?");
  const query = queryIndex >= 0 ? url.slice(queryIndex + 1) : url;
  const params = new URLSearchParams(query);

  const error = params.get("error");
  if (error) {
    return { ok: false, error, message: params.get("msg") };
  }

  const token = params.get("token");
  if (!token) {
    return { ok: false, error: "missing_token", message: null };
  }

  return {
    ok: true,
    token,
    action: params.get("action") ?? "login",
    userId: Number(params.get("user_id")) || 0,
  };
}

/** @deprecated Use {@link parseMobileAuthRedirect}; identical behaviour. */
export const parseMobileGoogleRedirect = parseMobileAuthRedirect;
