import {
  type AuthProviderAdapter,
  createFallbackProviderAdapter,
} from "./provider.js";
import type { AuthProviderName } from "../auth-types.js";

export * from "./provider.js";
import { AppleAdapter } from "./apple.js";
import { DiscordAdapter } from "./discord.js";
import { FluxerAdapter } from "./fluxer.js";
import { GoogleAdapter } from "./google.js";
export { AppleAdapter } from "./apple.js";
export { DiscordAdapter } from "./discord.js";
export { FluxerAdapter } from "./fluxer.js";
export { GoogleAdapter } from "./google.js";

/**
 * The adapters shipped by the library, mirroring the providers configured
 * server-side (`supportsBrowserFlow` = the provider has a browser flow).
 *
 * Always discover the live set with `AnimuAuth.getProviders()` — the server
 * can add providers without a client release, and unknown names transparently
 * resolve to {@link createFallbackProviderAdapter}.
 */
export const defaultProviderAdapters = new Map<AuthProviderName, AuthProviderAdapter>([
  [new DiscordAdapter().name, new DiscordAdapter()],
  [new GoogleAdapter().name, new GoogleAdapter()],
  [new AppleAdapter().name, new AppleAdapter()],
  [new FluxerAdapter().name, new FluxerAdapter()],
]);

/**
 * Runtime-registered custom adapters. Register one to support a provider the
 * library doesn't ship, or to override a built-in (registered first wins).
 */
const customAdapters = new Map<AuthProviderName, AuthProviderAdapter>();

/** Registers (or overrides) the adapter for `adapter.name`. */
export function registerProviderAdapter(adapter: AuthProviderAdapter): void {
  if (!adapter.name) {
    throw new Error("Provider adapters must have a name to be registered");
  }
  customAdapters.set(adapter.name, adapter);
}

/** Unregisters a custom adapter; `true` when one was present. */
export function unregisterProviderAdapter(
  name: AuthProviderName,
): boolean {
  return customAdapters.delete(name);
}

/** Adapters in resolution order: custom first, then the built-ins. */
export function providerAdapters(): ReadonlyMap<AuthProviderName, AuthProviderAdapter> {
  return new Map([...customAdapters, ...defaultProviderAdapters]);
}

/**
 * Resolves the adapter that will drive `provider`: custom registration first,
 * then a built-in, then the permissive fallback for anything the server added
 * without a matching client release. No name at all (server default) also
 * falls back so no `provider` field is injected — matching server behavior.
 */
export function resolveProviderAdapter(
  provider?: AuthProviderName,
): AuthProviderAdapter {
  if (!provider) return createFallbackProviderAdapter();
  return (
    customAdapters.get(provider) ??
    defaultProviderAdapters.get(provider) ??
    createFallbackProviderAdapter(provider)
  );
}
