import type { FetchLike } from "./http.js";
import type { ClientInfo } from "./types.js";

/**
 * Provider identifier as configured server-side (e.g. `"discord"`,
 * `"google"`, `"apple"`). Always discover the live set with
 * {@link AnimuAuth.getProviders} — new providers can be added without a
 * client release.
 */
export type AuthProviderName = string;

/** What happened on an OAuth login: a brand-new account or a returning one. */
export type AuthAction = "login" | "registered" | string;

/** A login provider available in the Auth API, as reported by the server. */
export interface ProviderInfo {
  name: AuthProviderName;
  /** Human-readable button label (e.g. `"Discord"`). */
  label: string;
}

/**
 * The authenticated user, as returned by the Auth API.
 *
 * Login responses are refreshed server-side before they return, so
 * `exchangeToken` / `verifyEmailLoginCode` fill every field (including
 * `handle`, `avatarCustom` and `verified`). Some other endpoints project a
 * smaller subset; missing fields are normalized to `null`/`false` rather than
 * left undefined, so consumers can treat the shape as stable.
 */
export interface AuthUser {
  id: number;
  /** Display name (custom user edit wins over the provider name). */
  username: string;
  /** Provider handle / Discord @username — the pedidos "nick". */
  handle: string | null;
  email: string | null;
  /**
   * Absolute avatar URL. Relative API paths (`api/v5/me/avatar.php`) are
   * resolved against the auth base; may be a provider CDN URL or `null`.
   */
  avatarUrl: string | null;
  /** `true` when the user uploaded a custom avatar (vs. the provider one). */
  avatarCustom: boolean;
  /**
   * `true` only when a Discord account is linked **and** it has 2FA enabled.
   * This is what gates the pedidos music queue.
   */
  verified: boolean;
  createdAt: string | null;
}

/**
 * Result of a successful login (`exchangeToken` / `verifyEmailLoginCode`).
 *
 * The server finishes every login with a best-effort re-fetch of all linked
 * providers (the same path `refreshProfile` uses), so `user` already carries
 * fresh name/handle/avatar/`verified` — no follow-up `refreshProfile` needed.
 * A provider outage never fails the login.
 */
export interface AuthSession {
  /** `PHPSESSID` value; stored on the client and sent as `X-Session-Id`. */
  sessionToken: string;
  action: AuthAction;
  user: AuthUser;
}

/** A provider identity linked to the current account. */
export interface LinkedProvider {
  provider: AuthProviderName;
  providerUserId: string;
  providerEmail: string | null;
  /** Provider @handle (e.g. Discord username), when the server supplies it. */
  providerUsername: string | null;
  /** Provider display name (e.g. Google name), when the server supplies it. */
  providerName: string | null;
}

/** The account's profile banner. When `url` is `null` use `color`. */
export interface AuthBanner {
  url: string | null;
  /** Discord accent color (hex) — fallback when no banner image is cached. */
  color: string | null;
}

/** Which identity source minted the current session. */
export interface AuthSessionInfo {
  sessionId: string;
  /**
   * `discord|google|fluxer|apple` for provider logins, `"animu"` for an
   * Animu Connect email-code login (`"native"` is the pre-v6 name, kept for
   * deploys older than the passwordless rename).
   */
  loginProvider: AuthProviderName | "animu" | "native" | null;
  /** Epoch seconds of the last activity, per the server. */
  lastActivity: number;
}

/** Convenience links exposed by the profile payload (absolute URLs). */
export interface AuthProfileLinks {
  avatar: string;
  browserLogin: string;
}

/** The full current profile returned by {@link AnimuAuth.getProfile}. */
export interface AuthProfile {
  user: AuthUser;
  banner: AuthBanner;
  linkedProviders: LinkedProvider[];
  availableProviders: ProviderInfo[];
  session: AuthSessionInfo;
  links: AuthProfileLinks;
}

/** Whether the supplied (or stored) session token is authenticated. */
export interface AuthSessionStatus {
  authenticated: boolean;
  sessionToken: string;
}

/** Result of {@link AnimuAuth.refreshProfile}. */
export interface AuthRefreshResult {
  updated: boolean;
  /** Discord-linked + 2FA, recomputed by the server. */
  verified: boolean;
  /** Server-side cached media (avatar/banner) is preserved on a provider/CDN hiccup. */
  user: AuthUser;
}

/** Result of requesting an Animu Connect email code (`data.sent`). */
export interface AuthEmailRequestResult {
  /** Always `true` — the server answers generically (no email enumeration). */
  sent: boolean;
}

/**
 * One of the account's Animu Connect emails: the provider emails
 * (auto-registered at login/link) plus the optional extra `source: "animu"`
 * email added from the profile.
 */
export interface AuthAccountEmail {
  id: number;
  /** Normalized (trim + lowercase) address. */
  email: string;
  /** `"provider"` for auto-registered provider emails, `"animu"` for the extra one. */
  source: "provider" | "animu" | string;
  /** The provider that registered it (`null` for the extra Animu Connect email). */
  provider: AuthProviderName | null;
  verified: boolean;
  /** `true` only for the extra `source: "animu"` email (removable via DELETE). */
  removable: boolean;
}

/** Result of the email-list / verify-email endpoints. */
export interface AuthEmailsResult {
  emails: AuthAccountEmail[];
}

/** Result of removing the extra Animu Connect email. */
export interface AuthRemoveEmailResult extends AuthEmailsResult {
  removed: boolean;
}

/** Parameters for verifying an Animu Connect email login code. */
export interface AuthEmailCodeParams {
  /** The address the code was sent to. */
  email: string;
  /** The 4-digit code (`EmailCodeTtl` 600 s, 5 attempts, 60 s resend cooldown). */
  code: string;
}

/** Result of linking an additional provider. */
export interface AuthLinkResult {
  action: AuthAction;
  provider: AuthProviderName;
  user: AuthUser;
  linkedProviders: LinkedProvider[];
}

/** Result of unlinking a provider. */
export interface AuthUnlinkResult {
  unlinked: boolean;
  provider: AuthProviderName;
  /** `true` when the account lost its identity and needs setup again. */
  needsSetup: boolean;
  linkedProviders: LinkedProvider[];
}

/** Raw bytes returned by the avatar/banner endpoints. */
export interface AuthImage {
  bytes: Uint8Array;
  contentType: string;
}

/** Parameters for exchanging an OAuth code (or native identity token) for a session. */
export interface AuthExchangeParams {
  /** Defaults to `"discord"` server-side when omitted. */
  provider?: AuthProviderName;
  /**
   * OAuth authorization code. For native Google Sign-In, pass the platform
   * SDK's `serverAuthCode` here. Required unless {@link identityToken} is sent.
   */
  code?: string;
  /**
   * Native **Sign in with Apple** RS256 `identityToken` (the `id_token` from
   * `expo-apple-authentication` / `ASAuthorization`). An alternative to `code`:
   * the server verifies it against Apple's JWKS — no `redirectUri`, PKCE,
   * Services ID or `.p8` involved.
   */
  identityToken?: string;
  /**
   * The exact redirect URI used for the authorize step.
   *
   * Required for every provider **except** native Google Sign-In
   * (`provider: "google"`) and Apple identity-token login, which omit it — the
   * server redeems those itself.
   */
  redirectUri?: string;
  /** PKCE code verifier (Discord/Google/Apple browser + PKCE flow). */
  codeVerifier?: string;
  /** Apple identity-token only: full name (Apple sends it on the first consent only). */
  name?: string;
  /** Apple identity-token only: given name. */
  firstName?: string;
  /** Apple identity-token only: family name. */
  lastName?: string;
}

/** Field for requesting the removal of one of the account's emails. */
export interface AuthRemoveEmailParams {
  /** Id of the email to remove — only the extra `source: "animu"` one is removable. */
  emailId: number;
}

/** Parameters for linking an additional provider via its OAuth code or native identity token. */
export interface AuthLinkParams {
  provider: AuthProviderName;
  /**
   * OAuth authorization code. For native Google Sign-In, pass the platform
   * SDK's `serverAuthCode` here. Required unless {@link identityToken} is sent.
   */
  code?: string;
  /**
   * Native **Sign in with Apple** RS256 `identityToken` (the `id_token`). An
   * alternative to `code` — verified against Apple's JWKS with no redirect/PKCE.
   */
  identityToken?: string;
  /**
   * The exact redirect URI used for the authorize step. Required for every
   * provider **except** native Google Sign-In and Apple identity-token linking,
   * which omit it.
   */
  redirectUri?: string;
  /** PKCE verifier, when the provider requires it. */
  codeVerifier?: string;
  /** Apple form_post callback only: the JSON `user` field from the initial consent callback. */
  user?: string;
  /** Apple identity-token only: full name. */
  name?: string;
  /** Apple identity-token only: given name. */
  firstName?: string;
  /** Apple identity-token only: family name. */
  lastName?: string;
}

/**
 * Legacy `discord_data` shape read by the unmodified mobile app and the
 * pedidos scripts: `id` is the Discord snowflake, `username` the @handle and
 * `mfa` the real 2FA state. Present only for Discord-linked accounts.
 */
export interface LegacyDiscordData {
  username: string;
  id: string;
  avatar: string;
  mfa: boolean;
  avatarUrl: string;
  nickname: string;
  avatarDecorationData: unknown;
}

/** Result of the legacy `/mobile/exchange-token.php` flow. */
export interface LegacyMobileSession {
  /** `discord_data` for Discord-linked accounts; `null` otherwise. */
  user: LegacyDiscordData | null;
  /** `PHPSESSID`; also stored on the client and sent as `X-Session-Id` after. */
  sessionToken: string;
  action: AuthAction;
}

/**
 * Result of intercepting the deep link the server bounces after **server-side
 * mobile auth** (`/mobile/google-start.php` or `/mobile/apple-start.php`).
 *
 * Success: `<PROVIDER_MOBILE_REDIRECT_URI>?token=<PHPSESSID>&action=…&user_id=…`
 * Failure: `<PROVIDER_MOBILE_REDIRECT_URI>?error=link_conflict|state|oauth[&msg=…]`
 */
export type MobileAuthRedirect =
  | {
      ok: true;
      /** Session token (`PHPSESSID`); adopted by `completeMobileAuth`. */
      token: string;
      action: AuthAction;
      /** Numeric user id from the bounce (`0` when absent). */
      userId: number;
    }
  | {
      ok: false;
      /** `link_conflict` | `state` | `oauth`, or `missing_token` if absent. */
      error: string;
      /** Provider/error detail when the server supplied one. */
      message: string | null;
    };

/** @deprecated Use {@link MobileAuthRedirect}; identical shape. */
export type MobileGoogleRedirect = MobileAuthRedirect;

/** Constructor options for {@link AnimuAuth}. All fields are optional. */
export interface AnimuAuthOptions {
  /**
   * Auth deployment base URL (no trailing slash), e.g.
   * `"https://www.animu.moe/teste/login_system_project"`.
   * Defaults to {@link ENDPOINTS.auth}.
   */
  baseUrl?: string;
  /** Sent as the User-Agent header on every request. Default: `"animu-api"`. */
  userAgent?: string;
  /**
   * Optional client descriptor: derives the User-Agent (when `userAgent` is
   * absent) and attaches `X-Client-*` headers to every auth request.
   */
  clientInfo?: ClientInfo;
  /** Per-request timeout in ms (default: 20000). */
  timeout?: number;
  /**
   * Fetch implementation override; defaults to the global fetch. Pass
   * `expo/fetch` in React Native (see {@link FetchLike}).
   *
   * The avatar/banner methods read raw bytes via `Response.arrayBuffer()`,
   * which React Native's global `fetch` does not implement — use
   * `expo/fetch` (or a web/Node runtime) for those.
   */
  fetchImpl?: FetchLike;
  /**
   * Session token to adopt up-front — useful to rehydrate a persisted
   * `PHPSESSID`. Login methods set it automatically.
   */
  sessionToken?: string | null;
}
