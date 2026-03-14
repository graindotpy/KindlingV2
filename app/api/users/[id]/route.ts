import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { ensureBackgroundServices } from "@/lib/bootstrap";
import {
  deleteLocalUser,
  DuplicateLocalUserNameError,
  LastLocalUserDeletionError,
  LocalUserHasRequestsError,
  updateLocalUser,
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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  ensureBackgroundServices();
  const authError = requireApiSession(request, { mutation: true });
  if (authError) {
    return authError;
  }

  const { id } = await context.params;
  const userId = Number(id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ message: "That profile id is not valid." }, { status: 400 });
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
    const updated = updateLocalUser(userId, {
      name: parsed.data.name,
      kindleEmail: parsed.data.kindleEmail || null,
    });

    if (!updated) {
      return NextResponse.json(
        { message: "We could not find that profile." },
        { status: 404 },
      );
    }

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof DuplicateLocalUserNameError) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }

    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "We could not save that profile right now.",
      },
      { status: 400 },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  ensureBackgroundServices();
  const authError = requireApiSession(request, { mutation: true });
  if (authError) {
    return authError;
  }

  const { id } = await context.params;
  const userId = Number(id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ message: "That profile id is not valid." }, { status: 400 });
  }

  try {
    const deleted = deleteLocalUser(userId);

    if (!deleted) {
      return NextResponse.json(
        { message: "We could not find that profile." },
        { status: 404 },
      );
    }

    return NextResponse.json(deleted);
  } catch (error) {
    if (
      error instanceof LocalUserHasRequestsError ||
      error instanceof LastLocalUserDeletionError
    ) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }

    if (error instanceof DuplicateLocalUserNameError) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }

    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "We could not delete that profile right now.",
      },
      { status: 400 },
    );
  }
}
