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
 * Fluxer login. Contract mirrors Discord: an authorization `code` with its
 * `redirectUri` (identify scope; no native identity token client-side).
 */
export class FluxerAdapter implements AuthProviderAdapter {
  readonly name = "fluxer" as const;
  readonly label = "Fluxer";
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
