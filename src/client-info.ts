import type { ClientInfo } from "./types.js";

/**
 * Client identification layer (labels/analytics only — never authorization).
 *
 * Two channels are produced from one {@link ClientInfo} descriptor:
 *
 * - **Headers** ({@link clientHeaders}): compact `X-Client-*` tokens for the
 *   JSON/SSE endpoints. Sent only by native clients — browsers are detected
 *   server-side via their own User-Agent, so we never trigger a CORS
 *   preflight from the web.
 * - **User-Agent** ({@link clientUserAgent}): a single human-readable string
 *   for channels that can't carry custom headers (Icecast/Shouty stream
 *   requests). This is what listener maps display, so it is deliberately
 *   ordered OS-first and kept ASCII-clean.
 */

/**
 * Strips anything that would break an HTTP header/UA token or a downstream
 * display (control chars, non-ASCII, delimiters), collapses whitespace and
 * truncates. The input is client-supplied and must be treated as untrusted.
 */
export function asciiSafe(value: string, max = 64): string {
  return value
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[;(),\\"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Builds the canonical Animu client User-Agent:
 *
 * `RadioAnimu/2.1.0 (iOS 27; iPhone 17 Pro Max; pt-BR; build 3)`
 *
 * OS comes first so truncated listener-map labels still reveal the platform.
 * Returns `undefined` when no descriptor is given, letting callers fall back
 * to {@link DEFAULT_USER_AGENT}.
 */
export function clientUserAgent(info?: ClientInfo): string | undefined {
  if (!info) return undefined;
  const parts: string[] = [];
  if (info.os) {
    parts.push(`${info.os} ${info.osVersion ?? ""}`.trim());
  }
  if (info.model) parts.push(asciiSafe(info.model));
  if (info.language) parts.push(asciiSafe(info.language, 16));
  if (
    info.deviceType &&
    info.deviceType !== "phone" &&
    info.deviceType !== "web"
  ) {
    parts.push(info.deviceType);
  }
  if (info.emulator) parts.push("emulator");
  const detail = parts.join("; ");
  const build = info.build ? `; build ${asciiSafe(info.build, 16)}` : "";
  return `RadioAnimu/${info.version ?? "0"} (${detail}${build})`;
}

/**
 * Builds the `X-Client-*` header set for native clients. Web (`platform:
 * "web"`) returns an empty set: the browser already sends its own
 * `User-Agent`, and emitting custom headers there would force a CORS
 * preflight the legacy endpoints don't answer.
 */
export function clientHeaders(info?: ClientInfo): Record<string, string> {
  if (!info || info.platform === "web") return {};
  const raw: Record<string, string> = {
    "X-Client-Platform": info.platform,
    "X-Client-App": info.app ?? "",
    "X-Client-Version": info.version ?? "",
    "X-Client-Build": info.build ?? "",
    "X-Client-Language": info.appLanguage ?? "",
    "X-Device-Model": info.model ? asciiSafe(info.model, 48) : "",
    "X-Device-Os": info.os
      ? asciiSafe(`${info.os} ${info.osVersion ?? ""}`.trim(), 48)
      : "",
    "X-Device-Region": info.region ? asciiSafe(info.region, 8) : "",
  };
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== ""),
  );
}

/**
 * Resolves the User-Agent to use: an explicit `userAgent` always wins; then
 * the descriptor-derived string; then the neutral default.
 */
export function resolveUserAgent(
  userAgent: string | undefined,
  info: ClientInfo | undefined,
  fallback: string,
): string {
  return userAgent ?? clientUserAgent(info) ?? fallback;
}
