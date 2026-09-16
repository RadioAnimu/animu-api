/**
 * Compatibility shim: `AnimuAuth` moved to `auth-facade.ts`, where it is
 * structured as a facade over per-provider adapters (`adapters/`) and a
 * {@link SessionStore} — mirroring the auth server's own architecture.
 */
export { AnimuAuth, type AnimuAuthFacadeOptions } from "./auth-facade.js";
export type { BinaryResponse } from "./http.js";
