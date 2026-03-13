import { NextResponse } from "next/server";
import { createRequestService } from "@/lib/requests/service";
import { ensureDefaultUsers } from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  ensureDefaultUsers();

  const { id } = await context.params;
  const requestId = Number(id);

  if (!Number.isInteger(requestId) || requestId <= 0) {
    return NextResponse.json({ message: "That request id is not valid." }, { status: 400 });
  }

  try {
    const requestRecord = await createRequestService().syncRequest(requestId);
    return NextResponse.json(requestRecord);
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error
            ? error.message
            : "We could not refresh that request right now.",
      },
      { status: 400 },
    );
  }
}
