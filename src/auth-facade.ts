import { DEFAULT_USER_AGENT, ENDPOINTS } from "./endpoints.js";
import { AnimuApiError } from "./errors.js";
import { HttpClient, type BinaryResponse, type RequestOptions } from "./http.js";
import {
  AuthAvatarDTOSchema,
  AuthEmailRemoveDTOSchema,
  AuthEmailSentDTOSchema,
  AuthEmailsDTOSchema,
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
  authRemoveEmailFromDTO,
  authEmailFromDTO,
  authEmailsFromDTO,
  authEmailSentFromDTO,
  authLinkFromDTO,
  authProfileFromDTO,
  authRefreshFromDTO,
  authSessionFromDTO,
  authUnlinkFromDTO,
  avatarUrlFromDTO,
  legacyMobileSessionFromDTO,
  parseMobileAuthRedirect,
  providerListFromDTO,
  sessionStatusFromDTO,
} from "./auth-mappers.js";
import type {
  AnimuAuthOptions,
  AuthEmailCodeParams,
  AuthEmailRequestResult,
  AuthEmailsResult,
  AuthExchangeParams,
  AuthImage,
  AuthLinkParams,
  AuthLinkResult,
  AuthProfile,
  AuthProviderName,
  AuthRefreshResult,
  AuthSession,
  AuthSessionStatus,
  AuthRemoveEmailResult,
  AuthUnlinkResult,
  LegacyMobileSession,
  MobileAuthRedirect,
  ProviderInfo,
} from "./auth-types.js";
import {
  type AuthProviderAdapter,
  resolveProviderAdapter,
} from "./adapters/index.js";
import { SessionStore } from "./session-store.js";

/** Constructor options for {@link AnimuAuth}, including the injectable session store. */
export interface AnimuAuthFacadeOptions extends AnimuAuthOptions {
  /**
   * Session token storage. Defaults to an in-memory {@link SessionStore};
   * derive a subclass to mirror the token into your app's persistence.
   */
  sessionStore?: SessionStore;
}

/**
 * Facade for the **Animu Auth API v5** — multi-provider OAuth (Discord,
 * Google, Apple, Fluxer) plus the native "Animu Connect" username/password
 * layer and full profile management.
 *
 * Architecturally this mirrors the auth server it talks to (`Auth/` in the
 * login-system project):
 *
 * - **Adapters** ({@link AuthProviderAdapter}) own each provider's *request
 *   contract* — which credentials a flow accepts (authorization code vs.
 *   native identity token) and which form fields each may or must carry.
 *   The server keeps the real OAuth plumbing (authorize URLs, PKCE, token
 *   redeem) server-side, exactly like its `Auth/Adapters/*` classes do.
 * - A **session store** ({@link SessionStore}) owns the `PHPSESSID` token
 *   lifecycle, mirroring the server's `SessionStore`.
 * - This class is the thin **facade** over both: it orchestrates endpoints,
 *   validates the `{ ok, data }` envelope at the boundary and maps payloads
 *   to camelCase domain types.
 *
 * Server failures (`{ ok: false, error }`) throw an {@link AnimuApiError}
 * carrying `.statusCode` and the machine-readable `.code` (e.g.
 * `"token_exchange_failed"`, `"missing_params"`, `"last_provider"`).
 *
 * The session token is the `PHPSESSID` returned at login. It is stored in the
 * session store automatically and sent back as the `X-Session-Id` header, but
 * every session method accepts an explicit `sessionId` override.
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
  private readonly sessions: SessionStore;

  /** @param options - All fields optional; defaults target the production deploy. */
  constructor(options: AnimuAuthFacadeOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ENDPOINTS.auth).replace(/\/+$/, "");
    this.http = new HttpClient(
      options.userAgent ?? DEFAULT_USER_AGENT,
      options.timeout ?? 20000,
      options.fetchImpl,
    );
    this.sessions = options.sessionStore ?? new SessionStore(options.sessionToken);
    if (options.sessionStore && options.sessionToken != null) {
      this.sessions.set(options.sessionToken);
    }
  }

  // ─── Session token ──────────────────────────────────────────────────────

  /** The session store backing this facade (see {@link SessionStore}). */
  get sessionStore(): SessionStore {
    return this.sessions;
  }

  /** The stored session token (`null` before login or after logout). */
  get sessionToken(): string | null {
    return this.sessions.current;
  }

  /** Adopts a session token (e.g. rehydrated from storage). Pass `null` to clear. */
  setSessionToken(token: string | null): void {
    this.sessions.set(token);
  }

  /** Forgets the stored session token without calling the server. */
  clearSession(): void {
    this.sessions.clear();
  }

  // ─── Provider adapters ──────────────────────────────────────────────────

  /**
   * The adapter owning `provider`'s request contract: a custom
   * `{@link registerProviderAdapter} registration`, then a built-in
   * (`discord`/`google`/`apple`/`fluxer`), then the permissive fallback for
   * anything the server added without a client release.
   */
  providerAdapterFor(provider?: AuthProviderName): AuthProviderAdapter {
    return resolveProviderAdapter(provider);
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
   * Exchanges an OAuth authorization code — or a native identity token — for a
   * session. This is the primary login for mobile/desktop/CLI.
   *
   * The PKCE exchange happens on the Animu server; your client secret never
   * touches this library. Each provider's required credentials are validated
   * pre-flight by its adapter ({@link providerAdapterFor}).
   *
   * **Native Google Sign-In**: send `provider: "google"` with the platform
   * SDK's `serverAuthCode` as `code` and no `redirectUri`/`codeVerifier`. The
   * server redeems it with the web OAuth client (the native SDK's
   * `serverClientId`). All other code flows require `redirectUri`.
   *
   * **Native Sign in with Apple**: send `provider: "apple"` with the platform
   * SDK's RS256 `identityToken` (and optional `name`/`firstName`/`lastName`) —
   * no `code`, `redirectUri`, PKCE, Services ID or `.p8`. The server verifies
   * it against Apple's JWKS.
   *
   * @throws {AnimuApiError} `400 missing_params` (adapter pre-flight),
   * `404 unknown_provider`, `401 token_exchange_failed`.
   */
  async exchangeToken(params: AuthExchangeParams): Promise<AuthSession> {
    const fields = this.providerAdapterFor(params.provider).buildExchangeFields(params);
    const data = unwrapEnvelope(
      AuthSessionDTOSchema,
      await this.postForm("auth/exchange-token.php", { ...fields }),
    );
    const session = authSessionFromDTO(data, this.baseUrl);
    this.sessions.set(session.sessionToken);
    return session;
  }

  /**
   * Animu Connect — requests the 4-digit login code to be emailed to `email`.
   *
   * The answer is always generic (no email enumeration): a code is only sent
   * when the address belongs to an account, and resends inside the server's
   * cooldown window are silently ignored. Follow up with
   * {@link verifyEmailLoginCode}.
   *
   * @throws {AnimuApiError} `400 invalid_request` (malformed email).
   */
  async requestEmailLoginCode(email: string): Promise<AuthEmailRequestResult> {
    const data = unwrapEnvelope(
      AuthEmailSentDTOSchema,
      await this.postForm("auth/email/request.php", { email }),
    );
    return authEmailSentFromDTO(data);
  }

  /**
   * Animu Connect: verifies the emailed 4-digit code and starts a session for
   * the account owning the address. Providers' emails are auto-registered, so
   * every Google/Apple/etc. login works here with no extra setup.
   *
   * Codes are single-use, expire after 600 s, are refused after 5 wrong
   * attempts, and resend waits 60 s (`EMAIL_CODE_*`).
   *
   * @throws {AnimuApiError} `401 email_code_failed` (wrong/expired code or
   * too many attempts).
   */
  async verifyEmailLoginCode(params: AuthEmailCodeParams): Promise<AuthSession> {
    const data = unwrapEnvelope(
      AuthSessionDTOSchema,
      await this.postForm("auth/email/verify.php", {
        email: params.email,
        code: params.code,
      }),
    );
    const session = authSessionFromDTO(data, this.baseUrl);
    this.sessions.set(session.sessionToken);
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
    const explicit = sessionId ?? this.sessions.current ?? undefined;
    const data = unwrapEnvelope(
      AuthLogoutDTOSchema,
      await this.http.post<unknown>(
        this.url("auth/logout.php"),
        undefined,
        this.requireSession(explicit),
      ),
    );
    if (sessionId === undefined || sessionId === this.sessions.current) {
      this.sessions.clear();
    }
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

  // ─── Animu Connect emails (session required) ────────────────────────────

  /**
   * Lists the account's Animu Connect emails: the provider emails
   * (auto-registered at login/link — Google/Apple/etc. work with no setup)
   * plus the optional extra `source: "animu"` address.
   */
  async getEmails(sessionId?: string): Promise<AuthEmailsResult> {
    const data = unwrapEnvelope(
      AuthEmailsDTOSchema,
      await this.http.get<unknown>(
        this.url("me/emails.php"),
        this.requireSession(sessionId),
      ),
    );
    return authEmailsFromDTO(data);
  }

  /**
   * Requests a code to add (or replace) the account's extra Animu Connect
   * email — there is **at most one** `source: "animu"` email; verifying with
   * {@link verifyAddEmail} replaces it.
   *
   * @throws {AnimuApiError} `400 invalid_request`, `409 email_taken` (the
   * email already belongs to any account, including your own provider emails).
   */
  async requestAddEmail(
    email: string,
    sessionId?: string,
  ): Promise<AuthEmailRequestResult> {
    const data = unwrapEnvelope(
      AuthEmailSentDTOSchema,
      await this.postForm(
        "me/emails.php",
        { email },
        this.requireSession(sessionId),
      ),
    );
    return authEmailSentFromDTO(data);
  }

  /**
   * Verifies the code sent to the new email and stores it as the account's
   * extra Animu Connect email, replacing any previous one.
   *
   * @returns The updated email list.
   * @throws {AnimuApiError} `401 email_code_failed`, `409 email_taken`.
   */
  async verifyAddEmail(
    params: AuthEmailCodeParams,
    sessionId?: string,
  ): Promise<AuthEmailsResult> {
    const data = unwrapEnvelope(
      AuthEmailsDTOSchema,
      await this.postForm(
        "me/emails/verify.php",
        { email: params.email, code: params.code },
        this.requireSession(sessionId),
      ),
    );
    return authEmailsFromDTO(data);
  }

  /**
   * Removes the extra Animu Connect email (`source: "animu"`). Provider
   * emails are not removable this way (server answers `404`).
   *
   * @returns `removed: true` plus the updated list.
   * @throws {AnimuApiError} `404 not_found`.
   */
  async removeEmail(
    emailId: number,
    sessionId?: string,
  ): Promise<AuthRemoveEmailResult> {
    const data = unwrapEnvelope(
      AuthEmailRemoveDTOSchema,
      await this.http.delete<unknown>(
        this.url("me/emails.php"),
        JSON.stringify({ email_id: emailId }),
        this.requireSession(sessionId, {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    return authRemoveEmailFromDTO(data);
  }

  /**
   * Links an additional provider without a browser session: run the
   * provider's OAuth redirect yourself and post the resulting code back —
   * exactly like {@link exchangeToken}. The provider's adapter validates the
   * credentials pre-flight ({@link providerAdapterFor}).
   *
   * **Native Google Sign-In**: linking Google can also send only
   * `provider: "google"` + the platform SDK's `serverAuthCode` as `code`, with
   * no `redirectUri`.
   *
   * **Native Sign in with Apple**: link with `provider: "apple"` + the SDK's
   * `identityToken` (no `code`/`redirectUri`).
   *
   * @throws {AnimuApiError} `400 link_failed`, `400 missing_params`,
   * `401 provider_error`, `404 unknown_provider`, `409 link_conflict`.
   */
  async linkProvider(
    params: AuthLinkParams,
    sessionId?: string,
  ): Promise<AuthLinkResult> {
    const fields = this.providerAdapterFor(params.provider).buildLinkFields(params);
    const data = unwrapEnvelope(
      AuthLinkDTOSchema,
      await this.postForm("me/link.php", { ...fields }, this.requireSession(sessionId)),
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
    this.sessions.clear();
    return data.deleted;
  }

  // ─── Legacy mobile contract ─────────────────────────────────────────────

  /**
   * Legacy mobile login (`/mobile/exchange-token.php`): the same OAuth code
   * exchange as {@link exchangeToken}, but returns the shape the unmodified
   * app and pedidos scripts expect (`{ user, PHPSESSID, action }`, no
   * envelope). Prefer {@link exchangeToken}.
   *
   * Accepts the same native Google `serverAuthCode` shape (no `redirectUri`).
   *
   * On failure the endpoint replies HTTP 200 with `{ error, message? }`; this
   * throws an {@link AnimuApiError} carrying that `error` as `.code`.
   */
  async legacyExchangeToken(
    params: AuthExchangeParams,
  ): Promise<LegacyMobileSession> {
    const url = this.mobileUrl("exchange-token.php");
    const fields = this.providerAdapterFor(params.provider).buildExchangeFields(params);
    const payload = await this.postFormAt<unknown>(url, { ...fields });

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
    this.sessions.set(session.sessionToken);
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
    if (sessionId === this.sessions.current) this.sessions.clear();
    return data === "1";
  }

  // ─── Server-side mobile auth (Discord / Google / Apple) ─────────────────

  /**
   * URL to open in a browser session to start **server-side mobile auth** for a
   * provider (`/mobile/<provider>-start.php`). Use it with
   * `WebBrowser.openAuthSessionAsync(url, "<PROVIDER_MOBILE_REDIRECT_URI>")`.
   *
   * Every browser-capable provider exposes the same flow. Google's and Apple's
   * web OAuth clients reject custom-scheme redirect URIs, so the app can't drive
   * their redirect itself; Discord works app-side but shares the endpoint so all
   * providers behave identically. The backend issues the state + PKCE, acts as
   * the provider's redirect target, then bounces the session token to the app
   * deep link — no native SDK, package or SHA-1 registration. Hand the
   * intercepted deep link to {@link completeMobileAuth}.
   *
   * @param provider - `"discord"`, `"google"` or `"apple"` (any configured
   * `*-start.php` endpoint). Unknown providers resolve to the permissive
   * fallback adapter ({@link providerAdapterFor}), whose browser flow flag
   * stays `true` so runtime-added providers keep working.
   * @param sessionId - Omit to **log in** (new/returning account). Pass the
   * current session token to **link** the provider to that account instead — the
   * server requires the token to be authenticated (else HTTP 401) and the
   * callback bounces `action: "linked"` with the token unchanged.
   */
  mobileStartUrl(provider: AuthProviderName, sessionId?: string): string {
    const url = this.mobileUrl(`${provider}-start.php`);
    return sessionId ? `${url}?sid=${encodeURIComponent(sessionId)}` : url;
  }

  /**
   * {@link mobileStartUrl} for Google (`/mobile/google-start.php`).
   *
   * @deprecated Prefer {@link mobileStartUrl} with `"google"`; kept as a
   * convenience alias.
   */
  googleMobileStartUrl(sessionId?: string): string {
    return this.mobileStartUrl("google", sessionId);
  }

  /**
   * {@link mobileStartUrl} for Apple (`/mobile/apple-start.php`) — Apple posts
   * the code back with `form_post`, which the backend callback handles.
   */
  appleMobileStartUrl(sessionId?: string): string {
    return this.mobileStartUrl("apple", sessionId);
  }

  /**
   * {@link mobileStartUrl} for Discord (`/mobile/discord-start.php`) — same
   * flow as the other providers, for parity with the app-driven Discord flow.
   */
  discordMobileStartUrl(sessionId?: string): string {
    return this.mobileStartUrl("discord", sessionId);
  }

  /**
   * Parses the deep-link callback from a server-side mobile flow and, on
   * success, adopts the session token (usable immediately via `X-Session-Id`).
   * Returns the parse result instead of throwing so callers can branch on `ok`.
   *
   * `action` is `"login"`/`"registered"` for a login and `"linked"` for a link
   * (the token is then the same one that was passed to {@link mobileStartUrl}).
   *
   * @param callbackUrl - The URL the browser session was redirected to, e.g.
   * `animuapp://redirect?token=…&action=linked&user_id=1` or
   * `animuapp://redirect?error=oauth&msg=…`.
   */
  completeMobileAuth(callbackUrl: string): MobileAuthRedirect {
    const result = parseMobileAuthRedirect(callbackUrl);
    if (result.ok) this.sessions.set(result.token);
    return result;
  }

  /**
   * {@link completeMobileAuth} (Google-named alias).
   *
   * @deprecated Prefer {@link completeMobileAuth}; identical behaviour.
   */
  completeMobileGoogleLogin(callbackUrl: string): MobileAuthRedirect {
    return this.completeMobileAuth(callbackUrl);
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
    const token = sessionId ?? this.sessions.current;
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
    const token = sessionId ?? this.sessions.current;
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
