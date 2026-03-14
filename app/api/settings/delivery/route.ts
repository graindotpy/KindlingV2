import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { ensureBackgroundServices } from "@/lib/bootstrap";
import { createDeliveryService } from "@/lib/delivery/service";
import { getDeliverySettings, updateDeliverySettings } from "@/lib/settings/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  watchDirectory: z.string().trim().or(z.literal("")).nullable(),
});

export async function GET(request: Request) {
  ensureBackgroundServices();
  const authError = requireApiSession(request);
  if (authError) {
    return authError;
  }

  return NextResponse.json(await getDeliverySettings());
}

export async function PUT(request: Request) {
  ensureBackgroundServices();
  const authError = requireApiSession(request, { mutation: true });
  if (authError) {
    return authError;
  }

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Please check the watched folder path." },
      { status: 400 },
    );
  }

  try {
    const settings = await updateDeliverySettings({
      watchDirectory: parsed.data.watchDirectory || null,
    });

    await createDeliveryService().runAutomaticWatchCycle();

    return NextResponse.json(settings);
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Please check the watched folder path.",
      },
      { status: 400 },
    );
  }
}
