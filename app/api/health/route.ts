import { NextResponse } from "next/server";
import { initializeDatabase } from "@/lib/db/client";
import { createReadarrService } from "@/lib/readarr/service";
import type { HealthResponse } from "@/lib/requests/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let database: HealthResponse["database"] = "ok";

  try {
    initializeDatabase();
  } catch {
    database = "error";
  }

  const readarrStatus = await createReadarrService().checkConnection();

  return NextResponse.json({
    app: "ok",
    database,
    readarr: readarrStatus,
  } satisfies HealthResponse);
}
