import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createAuthenticatedResponse,
  createSignedOutResponse,
  getSessionStatus,
  isAuthConfigured,
  requireSameOrigin,
  verifyAdminPassword,
} from "@/lib/auth";
import {
  getUnlockClientKey,
  getUnlockRetryAfterSeconds,
  recordUnlockFailure,
  recordUnlockSuccess,
} from "@/lib/auth-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  password: z.string().min(1, "Please enter the Kindling password.").max(1024),
});

function rateLimitedResponse(clientKey: string) {
  const retryAfter = getUnlockRetryAfterSeconds(clientKey);
  if (retryAfter === null) return null;
  return NextResponse.json(
    {
      message: `Too many incorrect passwords. Try again in ${Math.ceil(retryAfter / 60)} minute${retryAfter > 60 ? "s" : ""}.`,
    },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

export async function GET(request: Request) {
  return NextResponse.json(getSessionStatus(request));
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  if (!isAuthConfigured() && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      {
        message:
          "Kindling auth is not configured. Set KINDLING_ADMIN_PASSWORD and KINDLING_SESSION_SECRET.",
      },
      { status: 503 },
    );
  }

  const clientKey = getUnlockClientKey(request);
  const earlyLimit = rateLimitedResponse(clientKey);
  if (earlyLimit) return earlyLimit;

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Please enter the Kindling password." },
      { status: 400 },
    );
  }

  // Check again after the body has been read: concurrent or slow requests could
  // otherwise all pass the first check before any failure is recorded. From here
  // to recording the result there is no await, so the check and the count agree.
  const limited = rateLimitedResponse(clientKey);
  if (limited) return limited;

  if (!verifyAdminPassword(parsed.data.password)) {
    recordUnlockFailure(clientKey);
    return NextResponse.json(
      { message: "That Kindling password was not correct." },
      { status: 401 },
    );
  }

  recordUnlockSuccess(clientKey);
  return createAuthenticatedResponse(request);
}

export async function DELETE(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  return createSignedOutResponse(request);
}
