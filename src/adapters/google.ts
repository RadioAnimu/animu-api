import type { AuthExchangeParams, AuthLinkParams } from "../auth-types.js";
import {
  type AuthExchangeFields,
  type AuthLinkFields,
  type AuthProviderAdapter,
  exchangeFields,
  linkFields,
  missingParamError,
} from "./provider.js";

/**
 * Google login, with two distinct contracts:
 *
 * - **Browser / PKCE**: authorization `code` + its `redirectUri`.
 * - **Native Google Sign-In**: the platform SDK's `serverAuthCode` as `code`
 *   with **no** `redirectUri` — the server redeems it with its own web OAuth
 *   client (whose id is the native SDK's `serverClientId`).
 */
export class GoogleAdapter implements AuthProviderAdapter {
  readonly name = "google" as const;
  readonly label = "Google";
  readonly supportsBrowserFlow = true;
  readonly supportsIdentityToken = false;

  buildExchangeFields(params: AuthExchangeParams): AuthExchangeFields {
    if (!params.code) throw missingParamError(this.name, "code");
    return exchangeFields(params);
  }

  buildLinkFields(params: AuthLinkParams): AuthLinkFields {
    if (!params.code) throw missingParamError(this.name, "code");
    return linkFields(params);
  }
}
