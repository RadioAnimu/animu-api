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
 * Discord login (the canonical Animu identity).
 *
 * Contract: an authorization `code` **with** its `redirectUri` (browser or
 * app-driven PKCE flow). Discord's sign-in never mints a native identity
 * token on the client, so there is nothing else to accept.
 */
export class DiscordAdapter implements AuthProviderAdapter {
  readonly name = "discord" as const;
  readonly label = "Discord";
  readonly supportsBrowserFlow = true;
  readonly supportsIdentityToken = false;

  buildExchangeFields(params: AuthExchangeParams): AuthExchangeFields {
    if (!params.code || !params.redirectUri) {
      throw missingParamError(this.name, "code", "redirect_uri");
    }
    return exchangeFields(params);
  }

  buildLinkFields(params: AuthLinkParams): AuthLinkFields {
    if (!params.code || !params.redirectUri) {
      throw missingParamError(this.name, "code", "redirect_uri");
    }
    return linkFields(params);
  }
}
