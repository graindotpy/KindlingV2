import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getAppConfig } from "@/lib/config";

const SESSION_COOKIE_NAME = "kindling_session";

type SessionPayload = {
  exp: number;
};

type ApiSessionOptions = {
  mutation?: boolean;
};

function getAuthConfig() {
  const config = getAppConfig();

  return {
    password: config.auth.password,
    sessionSecret: config.auth.sessionSecret,
    sessionTtlMs: config.auth.sessionTtlMs,
    configured: Boolean(config.auth.password && config.auth.sessionSecret),
  };
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function compareText(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signValue(value: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function encodeSession(payload: SessionPayload, secret: string) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signValue(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

function decodeSession(token: string, secret: string) {
  const [encodedPayload, signature] = token.split(".", 2);
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signValue(encodedPayload, secret);
  if (!compareText(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as SessionPayload;

    if (!payload.exp || payload.exp <= Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function readCookieValue(request: Request, key: string) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";").map((entry) => entry.trim());
  const match = cookies.find((entry) => entry.startsWith(`${key}=`));
  if (!match) {
    return null;
  }

  return decodeURIComponent(match.slice(key.length + 1));
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }

  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function setSessionCookie(response: NextResponse, token: string, expiresAt: number) {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "strict",
    secure: isProduction(),
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function isAuthConfigured() {
  return getAuthConfig().configured;
}

export function verifyAdminPassword(password: string) {
  const config = getAuthConfig();
  if (!config.password) {
    return false;
  }

  return compareText(password, config.password);
}

export function isAuthenticatedRequest(request: Request) {
  const config = getAuthConfig();
  if (!config.configured) {
    return !isProduction();
  }

  const token = readCookieValue(request, SESSION_COOKIE_NAME);
  if (!token) {
    return false;
  }

  return Boolean(decodeSession(token, config.sessionSecret as string));
}

export function createAuthenticatedResponse() {
  const config = getAuthConfig();
  if (!config.configured) {
    return NextResponse.json(
      {
        message:
          "Kindling auth is not configured. Set KINDLING_ADMIN_PASSWORD and KINDLING_SESSION_SECRET.",
      },
      { status: isProduction() ? 503 : 400 },
    );
  }

  const expiresAt = Date.now() + config.sessionTtlMs;
  const token = encodeSession({ exp: expiresAt }, config.sessionSecret as string);
  const response = NextResponse.json({
    authenticated: true,
    expiresAt: new Date(expiresAt).toISOString(),
  });

  setSessionCookie(response, token, expiresAt);
  return response;
}

export function createSignedOutResponse() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: isProduction(),
    path: "/",
    expires: new Date(0),
  });
  return response;
}

export function getSessionStatus(request: Request) {
  const configured = isAuthConfigured();

  if (!configured) {
    return {
      configured,
      authenticated: !isProduction(),
      message: isProduction()
        ? "Kindling auth is not configured."
        : "Kindling auth is disabled for local development.",
    };
  }

  return {
    configured,
    authenticated: isAuthenticatedRequest(request),
    message: "Unlock Kindling to continue.",
  };
}

export function requireApiSession(request: Request, options: ApiSessionOptions = {}) {
  const status = getSessionStatus(request);

  if (!status.configured) {
    if (!isProduction()) {
      return null;
    }

    return NextResponse.json(
      {
        message:
          "Kindling auth is not configured. Set KINDLING_ADMIN_PASSWORD and KINDLING_SESSION_SECRET.",
        authRequired: true,
      },
      { status: 503 },
    );
  }

  if (options.mutation && !sameOrigin(request)) {
    return NextResponse.json(
      {
        message: "Cross-site request blocked.",
      },
      { status: 403 },
    );
  }

  if (!status.authenticated) {
    return NextResponse.json(
      {
        message: "Please unlock Kindling first.",
        authRequired: true,
      },
      { status: 401 },
    );
  }

  return null;
}
