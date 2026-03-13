import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createRequestService } from "@/lib/requests/service";
import { ensureDefaultUsers } from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const getQuerySchema = z.object({
  userId: z.coerce.number().int().positive(),
});

const selectionSchema = z
  .object({
    id: z.number().int().nonnegative().optional(),
    title: z.string().min(1),
    authorId: z.number().int().nonnegative().optional(),
    foreignBookId: z.string().min(1),
    foreignEditionId: z.string().nullable().optional(),
    titleSlug: z.string().nullable().optional(),
    releaseDate: z.string().nullable().optional(),
    remoteCover: z.string().nullable().optional(),
    images: z.array(z.any()).nullable().optional(),
    lastSearchTime: z.string().nullable().optional(),
    statistics: z.any().optional(),
    editions: z.array(z.any()).nullable().optional(),
    author: z
      .object({
        id: z.number().int().nonnegative().optional(),
        authorName: z.string().min(1),
        foreignAuthorId: z.string().min(1),
        titleSlug: z.string().nullable().optional(),
        remotePoster: z.string().nullable().optional(),
        images: z.array(z.any()).nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const createBodySchema = z.object({
  userId: z.number().int().positive(),
  selection: selectionSchema,
});

export async function GET(request: NextRequest) {
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
  ensureDefaultUsers();

  const body = await request.json().catch(() => null);
  const parsed = createBodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Please choose a book to request." },
      { status: 400 },
    );
  }

  try {
    const created = await createRequestService().createRequest(
      parsed.data.userId,
      parsed.data.selection,
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
