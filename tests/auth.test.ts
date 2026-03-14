import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthenticatedResponse, requireApiSession } from "@/lib/auth";
import { resetAppConfigCache } from "@/lib/config";

function getSessionCookie() {
  const response = createAuthenticatedResponse();
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

describe("requireApiSession", () => {
  beforeEach(() => {
    process.env.KINDLING_ADMIN_PASSWORD = "open-sesame";
    process.env.KINDLING_SESSION_SECRET = "session-secret";
    resetAppConfigCache();
  });

  afterEach(() => {
    delete process.env.KINDLING_ADMIN_PASSWORD;
    delete process.env.KINDLING_SESSION_SECRET;
    resetAppConfigCache();
  });

  it("rejects unauthenticated requests", () => {
    const request = new Request("http://localhost/api/requests");

    const response = requireApiSession(request);

    expect(response?.status).toBe(401);
  });

  it("accepts requests with a valid session cookie", () => {
    const request = new Request("http://localhost/api/requests", {
      headers: {
        cookie: getSessionCookie(),
      },
    });

    const response = requireApiSession(request);

    expect(response).toBeNull();
  });

  it("blocks cross-site mutation requests", () => {
    const request = new Request("http://localhost/api/requests", {
      method: "POST",
      headers: {
        cookie: getSessionCookie(),
        origin: "http://example.com",
      },
    });

    const response = requireApiSession(request, { mutation: true });

    expect(response?.status).toBe(403);
  });
});
