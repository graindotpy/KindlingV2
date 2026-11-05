import { NextResponse } from "next/server";
import { initializeDatabase } from "@/lib/db/client";
import { getBackgroundWorkerStatus } from "@/lib/worker-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Container liveness checks stay local and disclose no paths, keys or provider errors.
export async function GET() {
  try {
    initializeDatabase().prepare("SELECT 1").get();
    const worker = getBackgroundWorkerStatus().running ? "ok" : "unavailable";
    return NextResponse.json(
      { app: "ok", database: "ok", worker },
      { status: worker === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { app: "ok", database: "unavailable", worker: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
