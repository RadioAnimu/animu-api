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
 * Sign in with Apple, with two distinct contracts:
 *
 * - **Native identity token**: the platform SDK's RS256 `identityToken` —
 *   no `redirectUri`, PKCE, Services ID or `.p8` involved. Apple only sends
 *   the profile name on the **first** consent, so the `name`/`firstName`/
 *   `lastName` fields are accepted alongside it.
 * - **Authorization code**: `code` + its `redirectUri` (PKCE browser flow or
 *   the server's `form_post` callback).
 *
 * For linking, the `form_post` callback's JSON `user` field is carried along.
 */
export class AppleAdapter implements AuthProviderAdapter {
  readonly name = "apple" as const;
  readonly label = "Apple";
  readonly supportsBrowserFlow = true;
  readonly supportsIdentityToken = true;

  buildExchangeFields(params: AuthExchangeParams): AuthExchangeFields {
    if (!params.identityToken && (!params.code || !params.redirectUri)) {
      throw missingParamError(
        this.name,
        params.code ? "redirect_uri" : "identity_token",
      );
    }
    return exchangeFields(params);
  }

  buildLinkFields(params: AuthLinkParams): AuthLinkFields {
    this.buildExchangeFields(params);
    return linkFields(params);
  }
}
