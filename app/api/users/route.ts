import { NextResponse } from "next/server";
import { listLocalUsers } from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(listLocalUsers());
}
