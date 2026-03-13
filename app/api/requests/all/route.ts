import { NextResponse } from "next/server";
import { createRequestService } from "@/lib/requests/service";
import { ensureDefaultUsers } from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureDefaultUsers();

  try {
    const requests = await createRequestService().listAllRequests();
    return NextResponse.json(requests);
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error
            ? error.message
            : "We could not load the household request list right now.",
      },
      { status: 400 },
    );
  }
}
