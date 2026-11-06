import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { ensureBackgroundServices } from "@/lib/bootstrap";
import { createRequestService } from "@/lib/requests/service";
import { findSearchSelection } from "@/lib/search/selection-cache";
import { ensureDefaultUsers } from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getQuerySchema = z.object({
  userId: z.coerce.number().int().positive(),
});

// Only the identity of the chosen result is read from the browser. The full
// Readarr book is taken from Kindling's own recent search results.
const selectionSchema = z.object({
  foreignBookId: z.string().trim().min(1).max(200),
  author: z.object({
    foreignAuthorId: z.string().trim().min(1).max(200),
  }),
});

const createBodySchema = z.object({
  userId: z.number().int().positive(),
  requestFormat: z.enum(["ebook", "audiobook"]),
  selection: selectionSchema,
});

export async function GET(request: NextRequest) {
  const authError = requireApiSession(request);
  if (authError) {
    return authError;
  }
  ensureBackgroundServices();

  ensureDefaultUsers();

  const parsed = getQuerySchema.safeParse({
    userId: request.nextUrl.searchParams.get("userId") ?? "",
  });

  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Please choose a family member." },
      { status: 400 },
    );
  }

  try {
    const requests = await createRequestService().listRequestsForUser(parsed.data.userId);
    return NextResponse.json(requests);
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error
            ? error.message
            : "We could not load your requested books right now.",
      },
      { status: 400 },
    );
  }
}

export async function POST(request: NextRequest) {
  const authError = requireApiSession(request, { mutation: true });
  if (authError) {
    return authError;
  }
  ensureBackgroundServices();

  ensureDefaultUsers();

  const body = await request.json().catch(() => null);
  const parsed = createBodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Please choose a book to request." },
      { status: 400 },
    );
  }

  const selection = findSearchSelection(
    parsed.data.requestFormat,
    parsed.data.selection.foreignBookId,
    parsed.data.selection.author.foreignAuthorId,
  );
  if (!selection) {
    return NextResponse.json(
      { message: "That search result has expired. Please search for the book again." },
      { status: 409 },
    );
  }

  try {
    const created = await createRequestService().createRequest(
      parsed.data.userId,
      parsed.data.requestFormat,
      selection,
    );

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error
            ? error.message
            : "We could not save that request right now.",
      },
      { status: 400 },
    );
  }
}
