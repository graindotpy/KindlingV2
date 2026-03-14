import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { ensureBackgroundServices } from "@/lib/bootstrap";
import { createRequestService } from "@/lib/requests/service";
import { ensureDefaultUsers } from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  ensureBackgroundServices();
  const authError = requireApiSession(request, { mutation: true });
  if (authError) {
    return authError;
  }

  ensureDefaultUsers();

  const { id } = await context.params;
  const requestId = Number(id);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    return NextResponse.json({ message: "That request id is not valid." }, { status: 400 });
  }

  try {
    const requestRecord = await createRequestService().deleteRequest(requestId);
    return NextResponse.json(requestRecord);
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "We could not delete that request right now.",
      },
      { status: 400 },
    );
  }
}
