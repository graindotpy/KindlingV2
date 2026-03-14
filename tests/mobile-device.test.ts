import { describe, expect, it } from "vitest";
import { isMobileUserAgent } from "@/lib/mobile-device";

describe("isMobileUserAgent", () => {
  it("detects iPhone and Android phone user agents", () => {
    expect(
      isMobileUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 Version/17.3 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);

    expect(
      isMobileUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(true);
  });

  it("ignores desktop and tablet user agents", () => {
    expect(
      isMobileUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      ),
    ).toBe(false);

    expect(
      isMobileUserAgent(
        "Mozilla/5.0 (iPad; CPU OS 17_3 like Mac OS X) AppleWebKit/605.1.15 Version/17.3 Safari/604.1",
      ),
    ).toBe(false);
  });

  it("returns false when the user agent is missing", () => {
    expect(isMobileUserAgent(null)).toBe(false);
    expect(isMobileUserAgent(undefined)).toBe(false);
  });
});
