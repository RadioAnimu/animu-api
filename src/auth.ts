import { DEFAULT_USER_AGENT, ENDPOINTS } from "./endpoints.js";
import { AnimuApiError } from "./errors.js";
import { HttpClient, type BinaryResponse, type RequestOptions } from "./http.js";
import {
  AuthAvatarDTOSchema,
  AuthCredentialsDTOSchema,
  AuthDeleteDTOSchema,
  AuthLinkDTOSchema,
  AuthLogoutDTOSchema,
  AuthProfileDTOSchema,
  AuthRefreshDTOSchema,
  AuthSessionDTOSchema,
  AuthSessionStatusDTOSchema,
  AuthUnlinkDTOSchema,
  LegacyMobileSessionDTOSchema,
  ProviderListDTOSchema,
  unwrapEnvelope,
} from "./auth-schemas.js";
import {
  authCredentialsFromDTO,
  authLinkFromDTO,
  authProfileFromDTO,
  authRefreshFromDTO,
  authSessionFromDTO,
  authUnlinkFromDTO,
  avatarUrlFromDTO,
  legacyMobileSessionFromDTO,
  providerListFromDTO,
  sessionStatusFromDTO,
} from "./auth-mappers.js";
import type {
  AnimuAuthOptions,
  AuthCredentialsResult,
  AuthExchangeParams,
  AuthImage,
  AuthLinkParams,
  AuthLinkResult,
  AuthNativeLoginParams,
  AuthProfile,
  AuthProviderName,
  AuthRefreshResult,
  AuthSession,
  AuthSessionStatus,
  AuthSetCredentialsParams,
  AuthUnlinkResult,
  LegacyMobileSession,
  ProviderInfo,
} from "./auth-types.js";

/**
 * Client for the **Animu Auth API v5** — multi-provider OAuth (Discord,
 * Google, Apple) plus the native "Animu Connect" username/password layer and
 * full profile management.
 *
 * Every method validates the `{ ok, data }` envelope at the boundary and maps
 * it to camelCase domain types. Server failures (`{ ok: false, error }`) throw
 * an {@link AnimuApiError} carrying `.statusCode` and the machine-readable
 * `.code` (e.g. `"token_exchange_failed"`, `"last_provider"`).
 *
 * The session token is the `PHPSESSID` returned at login. It is stored on the
 * instance automatically and sent back as the `X-Session-Id` header, but every
 * session method accepts an explicit `sessionId` override.
 *
 * @example
 * ```ts
 * const auth = new AnimuAuth({ baseUrl: "https://www.animu.moe/teste/login_system_project" });
 * const providers = await auth.getProviders();
 * const { user, sessionToken } = await auth.exchangeToken({
 *   provider: "discord",
 *   code,
 *   redirectUri: "myapp://callback",
 * });
 * const profile = await auth.getProfile(); // reuses sessionToken
 * await auth.logout();
 * ```
 */
export class AnimuAuth {
  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private token: string | null;

  /** @param options - All fields optional; defaults target the production deploy. */
  constructor(options: AnimuAuthOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ENDPOINTS.auth).replace(/\/+$/, "");
    this.http = new HttpClient(
      options.userAgent ?? DEFAULT_USER_AGENT,
      options.timeout ?? 20000,
      options.fetchImpl,
    );
    this.token = options.sessionToken ?? null;
  }

  // ─── Session token ──────────────────────────────────────────────────────

  /** The stored session token (`null` before login or after logout). */
  get sessionToken(): string | null {
    return this.token;
  }

  /** Adopts a session token (e.g. rehydrated from storage). Pass `null` to clear. */
  setSessionToken(token: string | null): void {
    this.token = token;
  }

  /** Forgets the stored session token without calling the server. */
  clearSession(): void {
    this.token = null;
  }

  // ─── Public endpoints ───────────────────────────────────────────────────

  /**
   * Lists the configured login providers to build buttons from.
   *
   * Discover this at runtime instead of hardcoding the enum — providers can
   * be added server-side without a client release.
   */
  async getProviders(): Promise<ProviderInfo[]> {
    const data = unwrapEnvelope(
      ProviderListDTOSchema,
      await this.http.get<unknown>(this.url("providers.php")),
    );
    return providerListFromDTO(data);
  }

  /**
   * Exchanges an OAuth authorization code for a session. This is the primary
   * login for mobile/desktop/CLI — the client runs the provider's redirect
   * itself and posts the code back.
   *
   * The PKCE exchange happens on the Animu server; your client secret never
   * touches this library.
   *
   * @throws {AnimuApiError} `400 missing_params`, `404 unknown_provider`,
   * `401 token_exchange_failed`.
   */
  async exchangeToken(params: AuthExchangeParams): Promise<AuthSession> {
    const data = unwrapEnvelope(
      AuthSessionDTOSchema,
      await this.postForm("auth/exchange-token.php", {
        provider: params.provider,
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      }),
    );
    const session = authSessionFromDTO(data, this.baseUrl);
    this.token = session.sessionToken;
    return session;
  }

  /**
   * Logs in with Animu Connect (username/password).
   *
   * There is no native signup: credentials are created from an existing
   * account via {@link setCredentials}. After 8 failed attempts the username
   * is locked for 5 minutes.
   *
   * @throws {AnimuApiError} `401 native_auth_failed` (bad credentials or lock).
   */
  async nativeLogin(params: AuthNativeLoginParams): Promise<AuthSession> {
    const data = unwrapEnvelope(
      AuthSessionDTOSchema,
      await this.postForm("auth/native.php", {
        username: params.username,
        password: params.password,
      }),
    );
    const session = authSessionFromDTO(data, this.baseUrl);
    this.token = session.sessionToken;
    return session;
  }

  /**
   * Checks whether a session token is authenticated. Works with or without a
   * token; uses the stored one when `sessionId` is omitted.
   */
  async getSessionStatus(sessionId?: string): Promise<AuthSessionStatus> {
    const data = unwrapEnvelope(
      AuthSessionStatusDTOSchema,
      await this.http.get<unknown>(
        this.url("auth/session-status.php"),
        this.withSession(sessionId),
      ),
    );
    return sessionStatusFromDTO(data);
  }

  /**
   * Destroys the session server-side and clears the stored token.
   *
   * @throws {AnimuApiError} `401 unauthenticated` when no token is available.
   */
  async logout(sessionId?: string): Promise<boolean> {
    const explicit = sessionId ?? this.token ?? undefined;
    const data = unwrapEnvelope(
      AuthLogoutDTOSchema,
      await this.http.post<unknown>(
        this.url("auth/logout.php"),
        undefined,
        this.requireSession(explicit),
      ),
    );
    if (sessionId === undefined || sessionId === this.token) this.token = null;
    return data.logged_out;
  }

  // ─── Profile (session required) ─────────────────────────────────────────

  /**
   * Fetches the full current profile: user, banner, linked providers,
   * available providers, session info and convenience links.
   */
  async getProfile(sessionId?: string): Promise<AuthProfile> {
    const data = unwrapEnvelope(
      AuthProfileDTOSchema,
      await this.http.get<unknown>(
        this.url("me/profile.php"),
        this.requireSession(sessionId),
      ),
    );
    return authProfileFromDTO(data, this.baseUrl);
  }

  /**
   * Re-fetches every linked provider (refreshing stored tokens first) and
   * updates the profile + the `verified` flag.
   *
   * @throws {AnimuApiError} `409 refresh_failed`.
   */
  async refreshProfile(sessionId?: string): Promise<AuthRefreshResult> {
    const data = unwrapEnvelope(
      AuthRefreshDTOSchema,
      await this.postForm("me/refresh.php", {}, this.requireSession(sessionId)),
    );
    return authRefreshFromDTO(data, this.baseUrl);
  }

  /**
   * Sets up or updates Animu Connect credentials.
   *
   * `currentPassword` is required whenever credentials already exist (i.e. to
   * change the username or the password). The username is a login credential,
   * not the public display name.
   *
   * @throws {AnimuApiError} `409 credentials_failed`.
   */
  async setCredentials(
    params: AuthSetCredentialsParams,
    sessionId?: string,
  ): Promise<AuthCredentialsResult> {
    const data = unwrapEnvelope(
      AuthCredentialsDTOSchema,
      await this.postForm(
        "me/credentials.php",
        {
          username: params.username,
          password: params.password,
          current_password: params.currentPassword,
        },
        this.requireSession(sessionId),
      ),
    );
    return authCredentialsFromDTO(data);
  }

  /**
   * Links an additional provider without a browser session: run the
   * provider's OAuth redirect yourself and post the resulting code back —
   * exactly like {@link exchangeToken}.
   *
   * @throws {AnimuApiError} `400 link_failed`, `401 provider_error`,
   * `404 unknown_provider`, `409 link_conflict`.
   */
  async linkProvider(
    params: AuthLinkParams,
    sessionId?: string,
  ): Promise<AuthLinkResult> {
    const data = unwrapEnvelope(
      AuthLinkDTOSchema,
      await this.postForm(
        "me/link.php",
        {
          provider: params.provider,
          code: params.code,
          redirect_uri: params.redirectUri,
          code_verifier: params.codeVerifier,
          user: params.user,
        },
        this.requireSession(sessionId),
      ),
    );
    return authLinkFromDTO(data, this.baseUrl);
  }

  /**
   * Unlinks a provider. Fails with `last_provider` when it is the account's
   * only social login — link another provider or set up Animu Connect first.
   *
   * @throws {AnimuApiError} `400 unlink_failed`, `409 last_provider`.
   */
  async unlinkProvider(
    provider: AuthProviderName,
    sessionId?: string,
  ): Promise<AuthUnlinkResult> {
    const data = unwrapEnvelope(
      AuthUnlinkDTOSchema,
      await this.postForm(
        "me/unlink.php",
        { provider },
        this.requireSession(sessionId),
      ),
    );
    return authUnlinkFromDTO(data);
  }

  // ─── Media (session required) ───────────────────────────────────────────

  /**
   * Fetches the avatar as raw bytes: custom upload, then cached provider
   * avatar, then (server-side) a redirect to the provider CDN.
   *
   * @throws {AnimuApiError} `404 no_avatar`.
   */
  async getAvatar(sessionId?: string): Promise<AuthImage> {
    return this.http.getBinary(
      this.url("me/avatar.php"),
      this.requireSession(sessionId),
    );
  }

  /**
   * Uploads a custom avatar (`multipart/form-data`, field `avatar`).
   * jpeg/png/webp/gif, max 8 MB; the server re-encodes to a 256 px JPEG and
   * may run a NSFW filter.
   *
   * @returns The new (absolute) avatar URL, or `null`.
   * @throws {AnimuApiError} `400 invalid_upload`, `422 avatar_nsfw`.
   */
  async uploadAvatar(
    params: { avatar: Blob; filename?: string },
    sessionId?: string,
  ): Promise<string | null> {
    const form = new FormData();
    // Omit the filename unless given: Expo's `expo-file-system` File already
    // carries its own read-only `name`, and passing one is unnecessary there.
    if (params.filename) {
      form.append("avatar", params.avatar, params.filename);
    } else {
      form.append("avatar", params.avatar);
    }
    const data = unwrapEnvelope(
      AuthAvatarDTOSchema,
      await this.http.post<unknown>(
        this.url("me/avatar.php"),
        form,
        this.requireSession(sessionId),
      ),
    );
    return avatarUrlFromDTO(data, this.baseUrl);
  }

  /**
   * Resets to the provider avatar by clearing the custom upload.
   *
   * @returns The provider avatar URL, or `null`.
   */
  async resetAvatar(sessionId?: string): Promise<string | null> {
    const data = unwrapEnvelope(
      AuthAvatarDTOSchema,
      await this.http.delete<unknown>(
        this.url("me/avatar.php"),
        undefined,
        this.requireSession(sessionId),
      ),
    );
    return avatarUrlFromDTO(data, this.baseUrl);
  }

  /**
   * Fetches the cached provider banner as raw bytes. When no banner is cached
   * the server responds `404 no_banner` — fall back to `banner.color` from
   * {@link getProfile}.
   */
  async getBanner(sessionId?: string): Promise<AuthImage> {
    return this.http.getBinary(
      this.url("me/banner.php"),
      this.requireSession(sessionId),
    );
  }

  // ─── Account (session required) ─────────────────────────────────────────

  /**
   * Permanently deletes the profile, its links, Animu Connect credentials and
   * sessions (irreversible). Clears the stored token.
   */
  async deleteAccount(sessionId?: string): Promise<boolean> {
    const data = unwrapEnvelope(
      AuthDeleteDTOSchema,
      await this.http.delete<unknown>(
        this.url("me/account.php"),
        undefined,
        this.requireSession(sessionId),
      ),
    );
    this.token = null;
    return data.deleted;
  }

  // ─── Legacy mobile contract ─────────────────────────────────────────────

  /**
   * Legacy mobile login (`/mobile/exchange-token.php`): the same OAuth code
   * exchange as {@link exchangeToken}, but returns the shape the unmodified
   * app and pedidos scripts expect (`{ user, PHPSESSID, action }`, no
   * envelope). Prefer {@link exchangeToken}.
   *
   * On failure the endpoint replies HTTP 200 with `{ error, message? }`; this
   * throws an {@link AnimuApiError} carrying that `error` as `.code`.
   */
  async legacyExchangeToken(
    params: AuthExchangeParams,
  ): Promise<LegacyMobileSession> {
    const url = this.mobileUrl("exchange-token.php");
    const payload = await this.postFormAt<unknown>(url, {
      provider: params.provider,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    });

    if (payload && typeof payload === "object" && "error" in payload) {
      const error = payload as { error?: unknown; message?: unknown };
      const code = String(error.error ?? "token_exchange_failed");
      throw new AnimuApiError(
        typeof error.message === "string" && error.message
          ? error.message
          : code,
        200,
        { method: "POST", url },
        code,
      );
    }

    const session = legacyMobileSessionFromDTO(
      LegacyMobileSessionDTOSchema.parse(payload),
    );
    this.token = session.sessionToken;
    return session;
  }

  /**
   * Legacy parity with `chatIsThisReal.php`
   * (`GET /mobile/session-status.php`): `true` only when the session is a
   * logged-in **Discord** session (a Google/Apple-only session reads `0`).
   */
  async legacySessionStatus(sessionId: string): Promise<boolean> {
    const data = await this.http.get<string>(
      this.mobileUrl("session-status.php"),
      { params: { PHPSESSID: sessionId }, responseType: "text" },
    );
    return data === "1";
  }

  /**
   * Legacy parity with `byeChat.php` (`GET /mobile/session-logout.php`):
   * destroys the session and returns `true` when it was a logged-in Discord
   * session. Clears the stored token when it matches.
   */
  async legacySessionLogout(sessionId: string): Promise<boolean> {
    const data = await this.http.get<string>(
      this.mobileUrl("session-logout.php"),
      { params: { PHPSESSID: sessionId }, responseType: "text" },
    );
    if (sessionId === this.token) this.token = null;
    return data === "1";
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * The browser login URL (`/login.php`). Pass a provider to deep-link into
   * that provider's authorization redirect (`/login.php?start=<provider>`).
   */
  browserLoginUrl(provider?: AuthProviderName): string {
    const base = `${this.baseUrl}/login.php`;
    return provider ? `${base}?start=${encodeURIComponent(provider)}` : base;
  }

  /** Raw HTTP access for endpoints not yet covered by first-class methods. */
  get raw(): HttpClient {
    return this.http;
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v5/${path.replace(/^\/+/, "")}`;
  }

  private mobileUrl(path: string): string {
    return `${this.baseUrl}/mobile/${path.replace(/^\/+/, "")}`;
  }

  private async postFormAt<T>(
    url: string,
    data: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null || value === "") continue;
      body.append(key, String(value));
    }
    return this.http.post<T>(url, body.toString(), {
      ...options,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(options?.headers ?? {}),
      },
    });
  }

  private postForm<T>(
    path: string,
    data: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    return this.postFormAt<T>(this.url(path), data, options);
  }

  private requireToken(sessionId?: string): string {
    const token = sessionId ?? this.token;
    if (!token) {
      throw new AnimuApiError(
        "Missing session token — log in or pass one explicitly",
        401,
        { method: "GET", url: this.baseUrl },
        "unauthenticated",
      );
    }
    return token;
  }

  private withSession(
    sessionId?: string,
    extra?: RequestOptions,
  ): RequestOptions {
    const token = sessionId ?? this.token;
    const headers: Record<string, string> = { ...(extra?.headers ?? {}) };
    if (token) headers["X-Session-Id"] = token;
    return { ...extra, headers };
  }

  private requireSession(
    sessionId?: string,
    extra?: RequestOptions,
  ): RequestOptions {
    return this.withSession(this.requireToken(sessionId), extra);
  }
}

/** Re-exported so consumers don't need to import from `http.ts` for this. */
export type { BinaryResponse };
