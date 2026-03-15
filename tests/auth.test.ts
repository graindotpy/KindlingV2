import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthenticatedResponse, requireApiSession } from "@/lib/auth";
import { resetAppConfigCache } from "@/lib/config";

function getSessionCookie() {
  const response = createAuthenticatedResponse(new Request("http://localhost/api/auth/session"));
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
    delete process.env.KINDLING_TRUSTED_ORIGINS;
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

  it("accepts same-site mutation requests behind a forwarded host", () => {
    const request = new Request("http://kindling-web:3000/api/requests", {
      method: "POST",
      headers: {
        cookie: getSessionCookie(),
        origin: "http://192.168.4.148:3000",
        host: "kindling-web:3000",
        "x-forwarded-host": "192.168.4.148:3000",
        "x-forwarded-proto": "http",
      },
    });

    const response = requireApiSession(request, { mutation: true });

    expect(response).toBeNull();
  });

  it("accepts same-site mutation requests when the proxy keeps the public host but drops the proto", () => {
    const request = new Request("http://kindling-web:3000/api/requests", {
      method: "POST",
      headers: {
        cookie: getSessionCookie(),
        origin: "https://kindling.grainserver.co.uk",
        host: "kindling.grainserver.co.uk",
      },
    });

    const response = requireApiSession(request, { mutation: true });

    expect(response).toBeNull();
  });

  it("accepts trusted public origins when a proxy rewrites the backend host", () => {
    process.env.KINDLING_TRUSTED_ORIGINS = "https://kindling.grainserver.co.uk";
    resetAppConfigCache();

    const request = new Request("http://kindling-web:3000/api/requests", {
      method: "POST",
      headers: {
        cookie: getSessionCookie(),
        origin: "https://kindling.grainserver.co.uk",
        host: "kindling-web:3000",
      },
    });

    const response = requireApiSession(request, { mutation: true });

    expect(response).toBeNull();
  });
});

describe("createAuthenticatedResponse", () => {
  beforeEach(() => {
    process.env.KINDLING_ADMIN_PASSWORD = "open-sesame";
    process.env.KINDLING_SESSION_SECRET = "session-secret";
    resetAppConfigCache();
  });

  afterEach(() => {
    delete process.env.KINDLING_ADMIN_PASSWORD;
    delete process.env.KINDLING_SESSION_SECRET;
    delete process.env.KINDLING_TRUSTED_ORIGINS;
    resetAppConfigCache();
  });

  it("marks the session cookie as secure for trusted https origins", () => {
    process.env.KINDLING_TRUSTED_ORIGINS = "https://kindling.grainserver.co.uk";
    resetAppConfigCache();

    const response = createAuthenticatedResponse(
      new Request("http://kindling-web:3000/api/auth/session", {
        method: "POST",
        headers: {
          origin: "https://kindling.grainserver.co.uk",
          host: "kindling-web:3000",
        },
      }),
    );

    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
});
