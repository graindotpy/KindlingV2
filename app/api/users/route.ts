import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { ensureBackgroundServices } from "@/lib/bootstrap";
import {
  createLocalUser,
  DuplicateLocalUserNameError,
  listLocalUsers,
} from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  name: z.string().trim().min(1, "Please enter a profile name."),
  kindleEmail: z
    .string()
    .trim()
    .email("Please enter a valid Kindle email.")
    .or(z.literal(""))
    .nullable(),
});

export async function GET(request: Request) {
  ensureBackgroundServices();
  const authError = requireApiSession(request);
  if (authError) {
    return authError;
  }

  return NextResponse.json(listLocalUsers());
}

export async function POST(request: Request) {
  ensureBackgroundServices();
  const authError = requireApiSession(request, { mutation: true });
  if (authError) {
    return authError;
  }

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Please check this profile." },
      { status: 400 },
    );
  }

  try {
    const created = createLocalUser({
      name: parsed.data.name,
      kindleEmail: parsed.data.kindleEmail || null,
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof DuplicateLocalUserNameError) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }

    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "We could not create that profile right now.",
      },
      { status: 400 },
    );
  }
}
