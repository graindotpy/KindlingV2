import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createAuthenticatedResponse,
  createSignedOutResponse,
  getSessionStatus,
  isAuthConfigured,
  verifyAdminPassword,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  password: z.string().min(1, "Please enter the Kindling password."),
});

export async function GET(request: Request) {
  return NextResponse.json(getSessionStatus(request));
}

export async function POST(request: Request) {
  if (!isAuthConfigured() && process.env.NODE_ENV === "production") {
    return NextResponse.json(
      {
        message:
          "Kindling auth is not configured. Set KINDLING_ADMIN_PASSWORD and KINDLING_SESSION_SECRET.",
      },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Please enter the Kindling password." },
      { status: 400 },
    );
  }

  if (!verifyAdminPassword(parsed.data.password)) {
    return NextResponse.json(
      { message: "That Kindling password was not correct." },
      { status: 401 },
    );
  }

  return createAuthenticatedResponse(request);
}

export async function DELETE(request: Request) {
  return createSignedOutResponse(request);
}
