import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { ensureBackgroundServices } from "@/lib/bootstrap";
import { createRequestService } from "@/lib/requests/service";
import { ensureDefaultUsers } from "@/lib/users/service";
import { ReadarrApiError, type ReadarrAuthorBookSearch } from "@/lib/readarr/service";
import {
  createSearchResolver,
  SearchResolutionError,
} from "@/lib/search/resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().min(1, "Please enter a title or author.").max(300, "Please use a shorter title, author name, or ISBN."),
  userId: z.coerce.number().int().positive(),
  format: z.enum(["ebook", "audiobook"]).optional(),
  candidate: z.string().trim().regex(/^OL\d+W$/i, "Please choose a valid book suggestion.")
    .transform((value) => value.toUpperCase()).optional(),
});

export async function GET(request: NextRequest) {
  const authError = requireApiSession(request);
  if (authError) {
    return authError;
  }

  const parsed = querySchema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? "",
    userId: request.nextUrl.searchParams.get("userId") ?? "",
    format: request.nextUrl.searchParams.get("format") ?? undefined,
    candidate: request.nextUrl.searchParams.get("candidate") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Please check your search." },
      { status: 400 },
    );
  }

  try {
    ensureBackgroundServices();
    ensureDefaultUsers();
    const detailed = request.nextUrl.searchParams.get("details") === "1";
    const warnings: string[] = [];
    let searchQuery = parsed.data.q;
    let bookMatch: ReadarrAuthorBookSearch | null = null;

    if (detailed) {
      const resolution = await createSearchResolver().resolve(
        parsed.data.q,
        parsed.data.candidate,
        { signal: request.signal },
      );
      warnings.push(...resolution.warnings);
      if (resolution.state === "choose") {
        return NextResponse.json(
          {
            state: "choose",
            candidates: resolution.candidates,
            warnings: [...new Set(warnings)],
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      searchQuery = resolution.readarrQuery;
      bookMatch = resolution.bookMatch;
    }

    const results = await createRequestService().searchBooksForUser(
      parsed.data.userId,
      searchQuery,
      {
        format: parsed.data.format,
        bookMatch,
        onWarnings: (messages) => warnings.push(...messages),
      },
    );

    return NextResponse.json(
      detailed
        ? { state: "results", results, warnings: [...new Set(warnings)] }
        : results,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error
            ? error.message
            : "Search is unavailable right now. Please try again in a moment.",
      },
      {
        status:
          (error instanceof ReadarrApiError || error instanceof SearchResolutionError) &&
          error.status === 400
            ? 400
            : 503,
      },
    );
  }
}
