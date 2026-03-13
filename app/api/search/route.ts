import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createRequestService } from "@/lib/requests/service";
import { ensureDefaultUsers } from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().min(1, "Please enter a title or author."),
  userId: z.coerce.number().int().positive(),
});

export async function GET(request: NextRequest) {
  ensureDefaultUsers();

  const parsed = querySchema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? "",
    userId: request.nextUrl.searchParams.get("userId") ?? "",
  });

  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Please check your search." },
      { status: 400 },
    );
  }

  try {
    const results = await createRequestService().searchBooksForUser(
      parsed.data.userId,
      parsed.data.q,
    );

    return NextResponse.json(results);
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error
            ? error.message
            : "Search is unavailable right now. Please try again in a moment.",
      },
      { status: 503 },
    );
  }
}
