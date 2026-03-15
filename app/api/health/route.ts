import { NextResponse } from "next/server";
import { ensureBackgroundServices } from "@/lib/bootstrap";
import { initializeDatabase } from "@/lib/db/client";
import { createReadarrService } from "@/lib/readarr/service";
import type { HealthResponse } from "@/lib/requests/types";
import { getBackgroundWorkerStatus } from "@/lib/worker-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureBackgroundServices();
  let database: HealthResponse["database"] = "ok";
  let worker: HealthResponse["worker"] = {
    expected: false,
    running: false,
    lastStartedAt: null,
    lastHeartbeatAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    message: "Background worker status is unavailable because the database is not ready.",
  };

  try {
    initializeDatabase();
    worker = getBackgroundWorkerStatus();
  } catch {
    database = "error";
  }

  const [readarrStatus, audiobookReadarrStatus] = await Promise.all([
    createReadarrService("ebook").checkConnection(),
    createReadarrService("audiobook").checkConnection(),
  ]);

  return NextResponse.json({
    app: "ok",
    database,
    readarr: readarrStatus,
    audiobookReadarr: audiobookReadarrStatus,
    worker,
  } satisfies HealthResponse);
}
