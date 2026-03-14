import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { ensureBackgroundServices } from "@/lib/bootstrap";
import { KindleDeliveryError, createDeliveryService } from "@/lib/delivery/service";
import { ensureDefaultUsers, getLocalUserById } from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  recipientUserId: z.number().int().positive(),
});

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

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Please choose who should receive the book." },
      { status: 400 },
    );
  }

  const recipient = getLocalUserById(parsed.data.recipientUserId);
  if (!recipient) {
    return NextResponse.json(
      { message: "We could not find that Kindle profile." },
      { status: 404 },
    );
  }

  try {
    const result = await createDeliveryService().sendMatchedBookToUser({
      requestId,
      recipient,
      trigger: "manual",
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof KindleDeliveryError) {
      return NextResponse.json(
        {
          message: error.message,
          request: error.request,
          attempt: error.attempt,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        message:
          error instanceof Error
            ? error.message
            : "Kindling could not send that book right now.",
      },
      { status: 400 },
    );
  }
}
