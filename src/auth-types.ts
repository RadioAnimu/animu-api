import type { FetchLike } from "./http.js";

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
 * Not every endpoint fills every field: login responses omit `handle` and
 * `avatarCustom`, while profile/link responses include them. Fields are
 * normalized to `null`/`false` rather than left undefined, so consumers can
 * treat the shape as stable.
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

/** Result of a successful login (`exchangeToken` / `nativeLogin`). */
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
}

/** The account's profile banner. When `url` is `null` use `color`. */
export interface AuthBanner {
  url: string | null;
  /** Discord accent color (hex) — fallback when no banner image is cached. */
  color: string | null;
}

/** Which identity provider minted the current session. */
export interface AuthSessionInfo {
  sessionId: string;
  loginProvider: AuthProviderName | "native" | null;
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
  user: AuthUser;
}

/** State of the account's Animu Connect (native username/password) login. */
export interface AuthCredentialsResult {
  username: string;
  setUp: boolean;
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

/** Parameters for exchanging an OAuth authorization code for a session. */
export interface AuthExchangeParams {
  /** Defaults to `"discord"` server-side when omitted. */
  provider?: AuthProviderName;
  /**
   * OAuth authorization code. For native Google Sign-In, pass the platform
   * SDK's `serverAuthCode` here.
   */
  code: string;
  /**
   * The exact redirect URI used for the authorize step.
   *
   * Required for every provider **except** native Google Sign-In
   * (`provider: "google"`), which omits it — the server redeems the
   * `serverAuthCode` with the web OAuth client.
   */
  redirectUri?: string;
  /** PKCE code verifier (Discord/Google browser + PKCE flow). */
  codeVerifier?: string;
}

/** Parameters for Animu Connect (native username/password) login. */
export interface AuthNativeLoginParams {
  username: string;
  password: string;
}

/** Parameters for setting up or updating Animu Connect credentials. */
export interface AuthSetCredentialsParams {
  /** Login credential (3–32 chars: `[a-z0-9_.-]`), not the public name. */
  username: string;
  /** Required when setting up; optional when only renaming. */
  password?: string;
  /** Required whenever credentials already exist. */
  currentPassword?: string;
}

/** Parameters for linking an additional provider via its OAuth code. */
export interface AuthLinkParams {
  provider: AuthProviderName;
  /**
   * OAuth authorization code. For native Google Sign-In, pass the platform
   * SDK's `serverAuthCode` here.
   */
  code: string;
  /**
   * The exact redirect URI used for the authorize step. Required for every
   * provider **except** native Google Sign-In (`provider: "google"`), which
   * omits it.
   */
  redirectUri?: string;
  /** PKCE verifier, when the provider requires it. */
  codeVerifier?: string;
  /** Apple only: the JSON `user` field from the initial consent callback. */
  user?: string;
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
 * mobile Google login** (`/mobile/google-start.php`).
 *
 * Success: `<GOOGLE_MOBILE_REDIRECT_URI>?token=<PHPSESSID>&action=…&user_id=…`
 * Failure: `<GOOGLE_MOBILE_REDIRECT_URI>?error=link_conflict|state|oauth[&msg=…]`
 */
export type MobileGoogleRedirect =
  | {
      ok: true;
      /** Session token (`PHPSESSID`); adopted by `completeMobileGoogleLogin`. */
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
