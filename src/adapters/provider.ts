import { AnimuApiError } from "../errors.js";
import type {
  AuthExchangeParams,
  AuthLinkParams,
  AuthProviderName,
} from "../auth-types.js";

/**
 * Contract each identity provider implements — the client-side mirror of the
 * auth server's `AuthProviderInterface`.

 * The server owns the real OAuth plumbing (authorize URL, PKCE, token
 * redeem); on the client an adapter encodes the provider's **request
 * contract**: which credentials it accepts (authorization code vs. native
 * identity token) and which form fields each flow may or must carry.
 *
 * Provide your own implementation (and register it with
 * {@link registerProviderAdapter}) to support a provider the library doesn't
 * ship, or to override the built-in ones (`discord`, `google`, `apple`,
 * `fluxer`). Unknown provider names reported by the server fall back to a
 * permissive pass-through adapter, so server-side additions keep working
 * without a client release.
 */
export interface AuthProviderAdapter {
  /**
   * Provider identifier as configured server-side (e.g. `"discord"`).
   * Omitted on the dynamic fallback adapter, which never injects the field.
   */
  readonly name?: AuthProviderName;
  /** Human-readable label for UI (e.g. `"Discord"`). */
  readonly label: string;
  /**
   * `true` when the provider can drive the server-side browser OAuth flow
   * (`/mobile/<provider>-start.php` + `auth/exchange-token.php` with a code).
   */
  readonly supportsBrowserFlow: boolean;
  /** `true` when the provider accepts a native identity token (Sign in with Apple). */
  readonly supportsIdentityToken: boolean;

  /**
   * Builds the form fields for a code/identity-token session exchange with
   * this provider, validating the required credentials up-front.
   */
  buildExchangeFields(params: AuthExchangeParams): AuthExchangeFields;

  /**
   * Builds the form fields for linking this provider to an existing session,
   * validating the required credentials up-front.
   */
  buildLinkFields(params: AuthLinkParams): AuthLinkFields;
}

/** Form fields posted to `auth/exchange-token.php`. */
export interface AuthExchangeFields {
  provider?: string;
  code?: string;
  identity_token?: string;
  redirect_uri?: string;
  code_verifier?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
}

/** Form fields posted to `me/link.php` (adds Apple's `form_post` `user`). */
export interface AuthLinkFields extends AuthExchangeFields {
  user?: string;
}

/**
 * Builds an adapter for a provider the library doesn't (or no longer) ship a
 * dedicated class for. It is deliberately permissive — the server is the
 * source of truth for the provider's contract, so every supplied credential
 * is passed through and nothing is enforced client-side.
 */
export function createFallbackProviderAdapter(
  name?: AuthProviderName,
): AuthProviderAdapter {
  return {
    name,
    label: name ? (name.charAt(0).toUpperCase() + name.slice(1)) : "Animu",
    supportsBrowserFlow: true,
    supportsIdentityToken: true,
    buildExchangeFields: (params) => exchangeFields(params),
    buildLinkFields: (params) => linkFields(params),
  };
}

/**
 * The credential set every provider shares; adapters narrow or extend it.
 */
export function exchangeFields(
  params: AuthExchangeParams,
): AuthExchangeFields {
  return {
    provider: params.provider,
    code: params.code,
    identity_token: params.identityToken,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    name: params.name,
    first_name: params.firstName,
    last_name: params.lastName,
  };
}

export function linkFields(
  params: AuthLinkParams,
  extraFields: AuthLinkFields = {},
): AuthLinkFields {
  return {
    ...exchangeFields(params),
    user: params.user,
    ...extraFields,
  };
}

/** Thrown pre-flight when an adapter's contract is not satisfied. */
export function missingParamError(
  provider: AuthProviderName,
  ...params: string[]
): AnimuApiError {
  return new AnimuApiError(
    `${params.join(" and ")} ${params.length > 1 ? "are" : "is"} required for ${provider} login`,
    400,
    {},
    "missing_params",
  );
}
