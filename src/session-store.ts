/**
 * Holds the current `PHPSESSID` session token — the same seam as the auth
 * server's `SessionStore`, but client-side and in-memory (persist the token
 * in your app's storage and rehydrate it via `sessionToken` / `setSessionToken`).
 *
 * Kept as a separate collaborator so the facade is swappable: derive a
 * subclass to mirror the token into AsyncStorage, logs, etc. and hand an
 * instance to `new AnimuAuth({ sessionStore })`.
 */
export class SessionStore {
  private token: string | null;

  /** @param token Initial session token (e.g. rehydrated), `null` when fresh. */
  constructor(token?: string | null) {
    this.token = token ?? null;
  }

  /** The stored token, or `null` before login / after logout. */
  get current(): string | null {
    return this.token;
  }

  /** Adopts a token (`null` clears it). */
  set(token: string | null): void {
    this.token = token;
  }

  /** Effective token: `explicit ?? stored`. */
  resolve(explicit?: string | null): string | null {
    return explicit ?? this.token;
  }

  /** Forgets the token without touching the server. */
  clear(): void {
    this.token = null;
  }
}
