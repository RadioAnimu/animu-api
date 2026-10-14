import { describe, expect, it, vi } from "vitest";
import { AnimuAuth } from "../src/auth.js";
import { deriveArtworkVariants } from "../src/mappers.js";

describe("external URL boundaries", () => {
  it("normalizes long trailing-slash auth bases before making a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, data: { providers: [] } }), { status: 200 }));
    const auth = new AnimuAuth({ baseUrl: `https://example.test/auth${"/".repeat(50_000)}`, fetchImpl });
    expect(await auth.getProviders()).toEqual([]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://example.test/auth/api/v5/providers.php");
  });

  it("rejects malformed long artwork paths and retains size/query behavior", () => {
    expect(deriveArtworkVariants(`https://example.test/${"/".repeat(50_000)}missing.jpg`)).toBeNull();
    expect(deriveArtworkVariants("https://example.test/media/trackImage123_medium.webp?cache=4")).toEqual({
      tiny: "https://example.test/media/trackImage123_tiny.webp",
      medium: "https://example.test/media/trackImage123_medium.webp",
      large: "https://example.test/media/trackImage123_large.webp",
    });
    expect(deriveArtworkVariants("https://example.test/trackImage1_large.webp\n")).toBeNull();
  });
});
