import { describe, expect, it, vi } from "vitest";
import { AnimuApi } from "../src/animu-api";
import { AnimuAuth } from "../src/auth";
import { AnimuApiError } from "../src/errors";
import type { FetchLike } from "../src/http";

const BASE = "https://auth.test";

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function binaryResponse(
  bytes: number[],
  contentType = "image/jpeg",
  status = 200,
): Response {
  const data = Uint8Array.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => "",
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  } as unknown as Response;
}

/** Routed fake fetch that records every call. */
function mockFetch(
  routes: Array<{ match: (url: string) => boolean; reply: (url: string) => Response }>,
) {
  const calls: Call[] = [];
  const fn = vi.fn<FetchLike>(async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    });
    const route = routes.find((r) => r.match(String(url)));
    if (!route) throw new Error(`Unhandled fetch in test: ${url}`);
    return route.reply(String(url));
  });
  return { fn, calls };
}

function auth(fn: FetchLike, sessionToken?: string): AnimuAuth {
  return new AnimuAuth({ baseUrl: BASE, fetchImpl: fn, sessionToken });
}

const userPayload = {
  id: 1,
  username: "Nova",
  email: "nova@example.com",
  avatar_url: "https://cdn.discordapp.com/avatars/1/hash.png",
  created_at: "2026-09-11 18:00:00",
};

describe("getProviders", () => {
  it("unwraps the provider list", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/providers.php"), reply: () => jsonResponse({ ok: true, data: { providers: [{ name: "discord", label: "Discord" }, { name: "google", label: "Google" }] } }) },
    ]);

    const providers = await auth(fn).getProviders();

    expect(calls[0]!.url).toBe(`${BASE}/api/v5/providers.php`);
    expect(providers).toEqual([
      { name: "discord", label: "Discord" },
      { name: "google", label: "Google" },
    ]);
  });
});

describe("exchangeToken", () => {
  it("POSTs urlencoded params, stores the token and maps the user", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.includes("exchange-token"), reply: () => jsonResponse({ ok: true, data: { session_token: "php-sess-1", action: "registered", user: userPayload } }) },
    ]);
    const client = auth(fn);

    const session = await client.exchangeToken({ provider: "discord", code: "the-code", redirectUri: "myapp://cb", codeVerifier: "verifier" });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = String(calls[0]!.body);
    expect(body).toContain("provider=discord");
    expect(body).toContain("code=the-code");
    expect(body).toContain("redirect_uri=myapp%3A%2F%2Fcb");
    expect(body).toContain("code_verifier=verifier");
    expect(session.action).toBe("registered");
    expect(session.user.username).toBe("Nova");
    expect(session.user.avatarCustom).toBe(false);
    expect(client.sessionToken).toBe("php-sess-1");
  });

  it("omits undefined optional params", async () => {
    const { fn, calls } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: true, data: { session_token: "s", action: "login", user: userPayload } }) },
    ]);
    await auth(fn).exchangeToken({ code: "c", redirectUri: "r" });
    expect(String(calls[0]!.body)).not.toContain("provider=");
    expect(String(calls[0]!.body)).not.toContain("code_verifier=");
  });

  it("supports native Google Sign-In with no redirect_uri", async () => {
    const { fn, calls } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: true, data: { session_token: "g-sess", action: "registered", user: userPayload } }) },
    ]);

    await auth(fn).exchangeToken({ provider: "google", code: "server-auth-code" });

    const body = String(calls[0]!.body);
    expect(body).toContain("provider=google");
    expect(body).toContain("code=server-auth-code");
    expect(body).not.toContain("redirect_uri=");
    expect(body).not.toContain("code_verifier=");
  });

  it("supports native Sign in with Apple via identity_token", async () => {
    const { fn, calls } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: true, data: { session_token: "a-sess", action: "registered", user: userPayload } }) },
    ]);

    await auth(fn).exchangeToken({
      provider: "apple",
      identityToken: "header.payload.signature",
      name: "Haru Chan",
      firstName: "Haru",
      lastName: "Chan",
    });

    const body = String(calls[0]!.body);
    expect(body).toContain("provider=apple");
    expect(body).toContain("identity_token=header.payload.signature");
    expect(body).toContain("name=Haru+Chan");
    expect(body).toContain("first_name=Haru");
    expect(body).toContain("last_name=Chan");
    expect(body).not.toContain("code=");
    expect(body).not.toContain("redirect_uri=");
  });

  it("surfaces the server error code on failure", async () => {
    const { fn } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: false, error: { code: "token_exchange_failed", message: "invalid_grant" } }, 401) },
    ]);
    await expect(auth(fn).exchangeToken({ code: "c", redirectUri: "r" })).rejects.toMatchObject({
      name: "AnimuApiError",
      statusCode: 401,
      code: "token_exchange_failed",
      message: "invalid_grant",
    });
  });
});

describe("requestEmailLoginCode / verifyEmailLoginCode", () => {
  it("posts the email and answers generically", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/auth/email/request.php"), reply: () => jsonResponse({ ok: true, data: { sent: true } }) },
    ]);
    const auth0 = auth(fn);

    const result = await auth0.requestEmailLoginCode("meu@email.com");

    expect(String(calls[0]!.body)).toBe("email=meu%40email.com");
    expect(result).toEqual({ sent: true });
    expect(auth0.sessionToken).toBeNull(); // a code request never bundles a session
  });

  it("surfaces invalid_request", async () => {
    const { fn } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: false, error: { code: "invalid_request", message: "malformed email" } }, 400) },
    ]);
    await expect(auth(fn).requestEmailLoginCode("")).rejects.toMatchObject({ code: "invalid_request", statusCode: 400 });
  });

  it("verifies the code, maps the session and stores the token", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/auth/email/verify.php"), reply: () => jsonResponse({ ok: true, data: { session_token: "email-sess", action: "login", user: { ...userPayload, email: "meu@email.com", avatar_url: "api/v5/me/avatar.php", verified: true } } }) },
    ]);
    const client = auth(fn);

    const session = await client.verifyEmailLoginCode({ email: "meu@email.com", code: "1234" });

    const body = String(calls[0]!.body);
    expect(body).toContain("email=meu%40email.com");
    expect(body).toContain("code=1234");
    expect(session.user.email).toBe("meu@email.com");
    expect(session.user.verified).toBe(true);
    expect(session.user.avatarUrl).toBe(`${BASE}/api/v5/me/avatar.php`);
    expect(client.sessionToken).toBe("email-sess");
  });

  it("surfaces email_code_failed", async () => {
    const { fn } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: false, error: { code: "email_code_failed", message: "wrong code" } }, 401) },
    ]);
    await expect(auth(fn).verifyEmailLoginCode({ email: "meu@email.com", code: "0000" })).rejects.toMatchObject({ code: "email_code_failed", statusCode: 401 });
  });
});

describe("getSessionStatus", () => {
  it("sends the stored token as X-Session-Id", async () => {
    const { fn, calls } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: true, data: { authenticated: true, session_token: "abc" } }) },
    ]);
    const status = await auth(fn, "abc").getSessionStatus();
    expect(calls[0]!.headers?.["X-Session-Id"]).toBe("abc");
    expect(status).toEqual({ authenticated: true, sessionToken: "abc" });
  });

  it("works without a stored token", async () => {
    const { fn, calls } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: true, data: { authenticated: false, session_token: "" } }) },
    ]);
    const status = await auth(fn).getSessionStatus();
    expect(calls[0]!.headers?.["X-Session-Id"]).toBeUndefined();
    expect(status.authenticated).toBe(false);
  });

  it("accepts an explicit session id", async () => {
    const { fn, calls } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: true, data: { authenticated: true, session_token: "xyz" } }) },
    ]);
    await auth(fn).getSessionStatus("xyz");
    expect(calls[0]!.headers?.["X-Session-Id"]).toBe("xyz");
  });
});

describe("logout", () => {
  it("POSTs and clears the stored token", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/auth/logout.php"), reply: () => jsonResponse({ ok: true, data: { logged_out: true } }) },
    ]);
    const client = auth(fn, "abc");

    const loggedOut = await client.logout();

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers?.["X-Session-Id"]).toBe("abc");
    expect(loggedOut).toBe(true);
    expect(client.sessionToken).toBeNull();
  });

  it("throws without a token and never hits the network", async () => {
    const { fn } = mockFetch([]);
    await expect(auth(fn).logout()).rejects.toMatchObject({ statusCode: 401, code: "unauthenticated" });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("getProfile", () => {
  const profile = {
    ok: true,
    data: {
      user: {
        id: 1,
        username: "Nova",
        handle: "nova_",
        email: "nova@example.com",
        avatar_url: "api/v5/me/avatar.php",
        avatar_custom: true,
        verified: true,
        created_at: "2026-09-11 18:00:00",
      },
      banner: { url: "api/v5/me/banner.php", color: "#42008c" },
      linked_providers: [{ provider: "discord", provider_user_id: "123", provider_email: null }],
      available_providers: [{ name: "discord", label: "Discord" }, { name: "google", label: "Google" }],
      session: { session_id: "a1b2", login_provider: "discord", last_activity: 1783 },
      links: { avatar: "api/v5/me/avatar.php", browser_login: "https://auth.test/login.php" },
    },
  };

  it("maps the full profile and resolves relative URLs", async () => {
    const { fn, calls } = mockFetch([{ match: () => true, reply: () => jsonResponse(profile) }]);
    const result = await auth(fn, "a1b2").getProfile();

    expect(calls[0]!.headers?.["X-Session-Id"]).toBe("a1b2");
    expect(result.user.avatarCustom).toBe(true);
    expect(result.user.verified).toBe(true);
    expect(result.banner).toEqual({ url: `${BASE}/api/v5/me/banner.php`, color: "#42008c" });
    expect(result.linkedProviders).toEqual([
      {
        provider: "discord",
        providerUserId: "123",
        providerEmail: null,
        providerUsername: null,
        providerName: null,
      },
    ]);
    expect(result.availableProviders).toHaveLength(2);
    expect(result.session).toEqual({ sessionId: "a1b2", loginProvider: "discord", lastActivity: 1783 });
    expect(result.links.avatar).toBe(`${BASE}/api/v5/me/avatar.php`);
  });

  it("requires a session", async () => {
    const { fn } = mockFetch([]);
    await expect(auth(fn).getProfile()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("maps provider username/name when the server supplies them", async () => {
    const withIdentity = {
      ...profile,
      data: {
        ...profile.data,
        linked_providers: [
          { provider: "discord", provider_user_id: "123", provider_email: null, provider_username: "nova_", provider_name: "Nova" },
          { provider: "google", provider_user_id: "456", provider_email: "nova@example.com", provider_name: "Nova G" },
        ],
      },
    };
    const { fn } = mockFetch([{ match: () => true, reply: () => jsonResponse(withIdentity) }]);

    const { linkedProviders } = await auth(fn, "s").getProfile();

    expect(linkedProviders).toEqual([
      { provider: "discord", providerUserId: "123", providerEmail: null, providerUsername: "nova_", providerName: "Nova" },
      { provider: "google", providerUserId: "456", providerEmail: "nova@example.com", providerUsername: null, providerName: "Nova G" },
    ]);
  });
});

describe("refreshProfile", () => {
  it("copies the top-level verified flag onto the user", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/me/refresh.php"), reply: () => jsonResponse({ ok: true, data: { updated: true, verified: true, user: userPayload } }) },
    ]);

    const result = await auth(fn, "s").refreshProfile();

    expect(calls[0]!.method).toBe("POST");
    expect(result.updated).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.user.verified).toBe(true);
  });
});

describe("emails (me/emails.php)", () => {
  const emailsPayload = {
    emails: [
      { id: 1, email: "meu@gmail.com", source: "provider", provider: "google", verified: true, removable: false },
      { id: 2, email: "outro@email.com", source: "animu", provider: null, verified: true, removable: true },
    ],
  };

  it("lists the emails", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/me/emails.php"), reply: () => jsonResponse({ ok: true, data: emailsPayload }) },
    ]);

    const list = await auth(fn, "s").getEmails();

    expect(calls[0]!.url).toBe(`${BASE}/api/v5/me/emails.php`);
    expect(list).toEqual({
      emails: [
        { id: 1, email: "meu@gmail.com", source: "provider", provider: "google", verified: true, removable: false },
        { id: 2, email: "outro@email.com", source: "animu", provider: null, verified: true, removable: true },
      ],
    });
  });

  it("requests the add-email code and verifies it", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/me/emails.php"), reply: () => jsonResponse({ ok: true, data: { sent: true } }) },
      { match: (u) => u.endsWith("/me/emails/verify.php"), reply: () => jsonResponse({ ok: true, data: emailsPayload }) },
    ]);

    const a = auth(fn, "s");
    const sent = await a.requestAddEmail("outro@email.com");
    expect(String(calls[0]!.body)).toBe("email=outro%40email.com");
    expect(sent).toEqual({ sent: true });

    const verified = await a.verifyAddEmail({ email: "outro@email.com", code: "1234" });
    expect(String(calls[1]!.body)).toContain("code=1234");
    expect(verified.emails).toHaveLength(2);
  });

  it("deletes the extra email with a JSON body", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/me/emails.php"), reply: () => jsonResponse({ ok: true, data: { removed: true, emails: [] } }) },
    ]);

    const result = await auth(fn, "s").removeEmail(2);

    expect(calls[0]!.body).toBe(JSON.stringify({ email_id: 2 }));
    expect(result.removed).toBe(true);
  });

  it("surfaces email_taken", async () => {
    const { fn } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: false, error: { code: "email_taken", message: "email already in use" } }, 409) },
    ]);
    await expect(auth(fn, "s").requestAddEmail("outro@email.com")).rejects.toMatchObject({ code: "email_taken", statusCode: 409 });
  });
});
describe("link / unlink", () => {
  it("links a provider and returns the updated linked list", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/me/link.php"), reply: () => jsonResponse({ ok: true, data: { action: "linked", provider: "google", user: linkUser(), linked_providers: [{ provider: "discord", provider_user_id: "123", provider_email: null }, { provider: "google", provider_user_id: "456", provider_email: "nova@example.com" }] } }) },
    ]);

    const result = await auth(fn, "s").linkProvider({ provider: "google", code: "c", redirectUri: "r", user: '{"name":"Nova"}' });

    const body = String(calls[0]!.body);
    expect(body).toContain("provider=google");
    expect(body).toContain("user=%7B%22name%22%3A%22Nova%22%7D");
    expect(result.action).toBe("linked");
    expect(result.linkedProviders.map((p) => p.provider)).toEqual(["discord", "google"]);
  });

  it("links native Google without a redirect_uri", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/me/link.php"), reply: () => jsonResponse({ ok: true, data: { action: "linked", provider: "google", user: linkUser(), linked_providers: [] } }) },
    ]);

    const result = await auth(fn, "s").linkProvider({ provider: "google", code: "server-auth-code" });

    const body = String(calls[0]!.body);
    expect(body).toContain("provider=google");
    expect(body).toContain("code=server-auth-code");
    expect(body).not.toContain("redirect_uri=");
    expect(result.provider).toBe("google");
  });

  it("links native Sign in with Apple via identity_token", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/me/link.php"), reply: () => jsonResponse({ ok: true, data: { action: "linked", provider: "apple", user: linkUser(), linked_providers: [] } }) },
    ]);

    await auth(fn, "s").linkProvider({
      provider: "apple",
      identityToken: "h.p.s",
      firstName: "Haru",
      lastName: "Chan",
    });

    const body = String(calls[0]!.body);
    expect(body).toContain("provider=apple");
    expect(body).toContain("identity_token=h.p.s");
    expect(body).toContain("first_name=Haru");
    expect(body).not.toContain("code=");
    expect(body).not.toContain("redirect_uri=");
  });

  it("surfaces last_provider on unlink", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/me/unlink.php"), reply: () => jsonResponse({ ok: false, error: { code: "last_provider", message: "this is the only login method" } }, 409) },
    ]);

    await expect(auth(fn, "s").unlinkProvider("discord")).rejects.toMatchObject({ code: "last_provider" });
    expect(String(calls[0]!.body)).toBe("provider=discord");
  });

  it("returns needs_setup after unlinking the canonical provider", async () => {
    const { fn } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: true, data: { unlinked: true, provider: "discord", needs_setup: true, linked_providers: [{ provider: "google", provider_user_id: "456", provider_email: null }] } }) },
    ]);
    const result = await auth(fn, "s").unlinkProvider("discord");
    expect(result.needsSetup).toBe(true);
    expect(result.linkedProviders).toEqual([
      {
        provider: "google",
        providerUserId: "456",
        providerEmail: null,
        providerUsername: null,
        providerName: null,
      },
    ]);
  });
});

function linkUser() {
  return {
    id: 1,
    username: "Nova",
    handle: "nova_",
    email: "nova@example.com",
    avatar_url: "api/v5/me/avatar.php",
    avatar_custom: false,
    verified: true,
    created_at: "2026-09-11 18:00:00",
  };
}

describe("avatar / banner", () => {
  it("getAvatar returns bytes and content type", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/me/avatar.php"), reply: () => binaryResponse([1, 2, 3]) },
    ]);

    const image = await auth(fn, "s").getAvatar();

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers?.["X-Session-Id"]).toBe("s");
    expect(Array.from(image.bytes)).toEqual([1, 2, 3]);
    expect(image.contentType).toBe("image/jpeg");
  });

  it("getAvatar surfaces no_avatar as an error code", async () => {
    const { fn } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: false, error: { code: "no_avatar", message: "this profile has no avatar" } }, 404) },
    ]);
    await expect(auth(fn, "s").getAvatar()).rejects.toMatchObject({ code: "no_avatar", statusCode: 404 });
  });

  it("uploadAvatar posts multipart and resolves the returned URL", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/me/avatar.php"), reply: () => jsonResponse({ ok: true, data: { avatar_url: "api/v5/me/avatar.php" } }) },
    ]);
    const blob = new Blob(["image-bytes"], { type: "image/jpeg" });

    const url = await auth(fn, "s").uploadAvatar({ avatar: blob, filename: "me.jpg" });

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toBeInstanceOf(FormData);
    expect((calls[0]!.body as FormData).get("avatar")).toBeInstanceOf(Blob);
    expect(url).toBe(`${BASE}/api/v5/me/avatar.php`);
  });

  it("uploadAvatar omits the filename unless provided (Expo File keeps its own name)", async () => {
    const { fn } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: true, data: { avatar_url: "api/v5/me/avatar.php" } }) },
    ]);
    const spy = vi.spyOn(FormData.prototype, "append");

    await auth(fn, "s").uploadAvatar({ avatar: new Blob(["x"]) });
    expect(spy).toHaveBeenLastCalledWith("avatar", expect.any(Blob));

    spy.mockClear();
    await auth(fn, "s").uploadAvatar({ avatar: new Blob(["x"]), filename: "me.jpg" });
    expect(spy).toHaveBeenLastCalledWith("avatar", expect.any(Blob), "me.jpg");

    spy.mockRestore();
  });

  it("resetAvatar DELETEs and returns the provider URL", async () => {
    const { fn, calls } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: true, data: { avatar_url: "https://cdn.discordapp.com/a.png" } }) },
    ]);
    const url = await auth(fn, "s").resetAvatar();
    expect(calls[0]!.method).toBe("DELETE");
    expect(url).toBe("https://cdn.discordapp.com/a.png");
  });

  it("getBanner surfaces no_banner", async () => {
    const { fn } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: false, error: { code: "no_banner", message: "no banner" } }, 404) },
    ]);
    await expect(auth(fn, "s").getBanner()).rejects.toMatchObject({ code: "no_banner" });
  });
});

describe("deleteAccount", () => {
  it("DELETEs and clears the token", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/api/v5/me/account.php"), reply: () => jsonResponse({ ok: true, data: { deleted: true } }) },
    ]);
    const client = auth(fn, "s");
    expect(await client.deleteAccount()).toBe(true);
    expect(calls[0]!.method).toBe("DELETE");
    expect(client.sessionToken).toBeNull();
  });
});

describe("session token management", () => {
  it("adopts and clears tokens explicitly", () => {
    const client = auth(vi.fn());
    expect(client.sessionToken).toBeNull();
    client.setSessionToken("tok");
    expect(client.sessionToken).toBe("tok");
    client.clearSession();
    expect(client.sessionToken).toBeNull();
  });

  it("builds browser login URLs", () => {
    const client = auth(vi.fn());
    expect(client.browserLoginUrl()).toBe(`${BASE}/login.php`);
    expect(client.browserLoginUrl("discord")).toBe(`${BASE}/login.php?start=discord`);
  });
});

describe("AnimuApi.auth", () => {
  it("exposes an auth client sharing the configured base and fetch", async () => {
    const { fn, calls } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ ok: true, data: { providers: [] } }) },
    ]);
    const api = new AnimuApi({ authBaseUrl: BASE, fetchImpl: fn });

    expect(api.auth).toBeInstanceOf(AnimuAuth);
    await api.auth.getProviders();
    expect(calls[0]!.url).toBe(`${BASE}/api/v5/providers.php`);
  });
});

describe("legacy mobile contract", () => {
  it("legacyExchangeToken maps discord_data and stores the token", async () => {
    const { fn, calls } = mockFetch([
      {
        match: (u) => u.endsWith("/mobile/exchange-token.php"),
        reply: () =>
          jsonResponse({
            user: {
              username: "nova_",
              id: "123",
              avatar: "hash",
              mfa: true,
              avatar_url: "https://cdn.discordapp.com/a.png",
              nickname: "Nova",
              avatar_decoration_data: null,
            },
            PHPSESSID: "legacy-sess",
            action: "registered",
          }),
      },
    ]);
    const client = auth(fn);

    const session = await client.legacyExchangeToken({ provider: "discord", code: "c", redirectUri: "r" });

    expect(calls[0]!.url).toBe(`${BASE}/mobile/exchange-token.php`);
    expect(session.action).toBe("registered");
    expect(session.sessionToken).toBe("legacy-sess");
    expect(session.user).toEqual({
      username: "nova_",
      id: "123",
      avatar: "hash",
      mfa: true,
      avatarUrl: "https://cdn.discordapp.com/a.png",
      nickname: "Nova",
      avatarDecorationData: null,
    });
    expect(client.sessionToken).toBe("legacy-sess");
  });

  it("legacyExchangeToken allows a null user (no Discord link)", async () => {
    const { fn } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ user: null, PHPSESSID: "s", action: "login" }) },
    ]);
    const session = await auth(fn).legacyExchangeToken({ code: "c", redirectUri: "r" });
    expect(session.user).toBeNull();
  });

  it("legacyExchangeToken supports native Google without a redirect_uri", async () => {
    const { fn, calls } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ user: null, PHPSESSID: "g", action: "registered" }) },
    ]);
    await auth(fn).legacyExchangeToken({ provider: "google", code: "server-auth-code" });
    const body = String(calls[0]!.body);
    expect(body).toContain("provider=google");
    expect(body).not.toContain("redirect_uri=");
  });

  it("legacyExchangeToken surfaces a 200 body error as a code", async () => {
    const { fn } = mockFetch([
      { match: () => true, reply: () => jsonResponse({ error: "token_exchange_failed", message: "boom" }) },
    ]);
    await expect(auth(fn).legacyExchangeToken({ code: "c", redirectUri: "r" })).rejects.toMatchObject({
      name: "AnimuApiError",
      code: "token_exchange_failed",
      message: "boom",
    });
  });

  it("legacySessionStatus returns true only for '1'", async () => {
    const { fn, calls } = mockFetch([
      { match: () => true, reply: () => jsonResponse("1") },
    ]);
    expect(await auth(fn).legacySessionStatus("sess")).toBe(true);
    expect(calls[0]!.url).toContain("PHPSESSID=sess");
  });

  it("legacySessionLogout clears the token when it matches", async () => {
    const { fn } = mockFetch([{ match: () => true, reply: () => jsonResponse("1") }]);
    const client = auth(fn, "sess");
    expect(await client.legacySessionLogout("sess")).toBe(true);
    expect(client.sessionToken).toBeNull();
  });
});

describe("server-side mobile auth", () => {
  it("exposes the google-start URL", () => {
    expect(auth(vi.fn()).googleMobileStartUrl()).toBe(`${BASE}/mobile/google-start.php`);
  });

  it("exposes the apple-start URL", () => {
    const client = auth(vi.fn());
    expect(client.appleMobileStartUrl()).toBe(`${BASE}/mobile/apple-start.php`);
    expect(client.mobileStartUrl("apple", "tok")).toBe(`${BASE}/mobile/apple-start.php?sid=tok`);
    expect(client.mobileStartUrl("google")).toBe(`${BASE}/mobile/google-start.php`);
  });

  it("exposes the discord-start URL", () => {
    const client = auth(vi.fn());
    expect(client.discordMobileStartUrl()).toBe(`${BASE}/mobile/discord-start.php`);
    expect(client.mobileStartUrl("discord", "tok")).toBe(`${BASE}/mobile/discord-start.php?sid=tok`);
  });

  it("appends the session token for link mode", () => {
    const client = auth(vi.fn());
    expect(client.googleMobileStartUrl("php-sess 1")).toBe(`${BASE}/mobile/google-start.php?sid=php-sess%201`);
    // no implicit use of the stored token — login must stay a login
    expect(auth(vi.fn(), "stored").googleMobileStartUrl()).toBe(`${BASE}/mobile/google-start.php`);
  });

  it("parses a linked Apple bounce via completeMobileAuth", () => {
    const client = auth(vi.fn());
    const result = client.completeMobileAuth("animuapp://redirect?token=a-sess&action=linked&user_id=7");
    expect(result).toEqual({ ok: true, token: "a-sess", action: "linked", userId: 7 });
    expect(client.sessionToken).toBe("a-sess");
  });

  it("handles a linked bounce (action=linked, same token)", () => {
    const client = auth(vi.fn(), "php-sess-9");
    const result = client.completeMobileGoogleLogin("animuapp://redirect?token=php-sess-9&action=linked&user_id=42");
    expect(result).toEqual({ ok: true, token: "php-sess-9", action: "linked", userId: 42 });
    expect(client.sessionToken).toBe("php-sess-9");
  });

  it("parses the deep link and adopts the token", () => {
    const client = auth(vi.fn());

    const result = client.completeMobileGoogleLogin("animuapp://redirect?token=php-sess-9&action=registered&user_id=42");

    expect(result).toEqual({ ok: true, token: "php-sess-9", action: "registered", userId: 42 });
    expect(client.sessionToken).toBe("php-sess-9");
  });

  it("defaults action to login and userId to 0 when absent", () => {
    const result = auth(vi.fn()).completeMobileGoogleLogin("animuapp://redirect?token=t");
    expect(result).toEqual({ ok: true, token: "t", action: "login", userId: 0 });
  });

  it("reports error bounces without touching the token", () => {
    const client = auth(vi.fn(), "existing");

    expect(client.completeMobileGoogleLogin("animuapp://redirect?error=link_conflict")).toEqual({
      ok: false,
      error: "link_conflict",
      message: null,
    });
    expect(client.completeMobileGoogleLogin("animuapp://redirect?error=oauth&msg=boom")).toEqual({
      ok: false,
      error: "oauth",
      message: "boom",
    });
    expect(client.sessionToken).toBe("existing");
  });

  it("flags a missing token", () => {
    expect(auth(vi.fn()).completeMobileGoogleLogin("animuapp://redirect?action=login")).toEqual({
      ok: false,
      error: "missing_token",
      message: null,
    });
  });
});
