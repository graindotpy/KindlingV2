import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppConfigCache } from "@/lib/config";
import { createSmtpMailer } from "@/lib/delivery/mailer";

const ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SMTP_FROM_EMAIL",
  "SMTP_MAX_ATTACHMENT_BYTES",
] as const;

const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

async function createTempBookFile(sizeInBytes: number) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kindling-mailer-"));
  const filePath = path.join(tempDir, `book-${sizeInBytes}.epub`);
  await fs.writeFile(filePath, Buffer.alloc(sizeInBytes, 0));
  return { filePath, tempDir };
}

describe("createSmtpMailer.sendBook", () => {
  beforeEach(() => {
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_USERNAME = "mailer-user";
    process.env.SMTP_PASSWORD = "mailer-password";
    process.env.SMTP_FROM_EMAIL = "kindling@example.com";
    delete process.env.SMTP_MAX_ATTACHMENT_BYTES;
    resetAppConfigCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const originalValue = ORIGINAL_ENV[key];
      if (originalValue === undefined) {
        delete process.env[key];
        continue;
      }

      process.env[key] = originalValue;
    }

    resetAppConfigCache();
  });

  it("sends files that are within the configured attachment limit", async () => {
    process.env.SMTP_MAX_ATTACHMENT_BYTES = "2048";
    resetAppConfigCache();

    const { filePath, tempDir } = await createTempBookFile(1024);
    const sendMail = vi.fn(async () => ({ messageId: "message-1" }));
    const mailer = createSmtpMailer({
      transporter: {
        sendMail,
        verify: vi.fn(async () => true),
      } as never,
    });

    try {
      const result = await mailer.sendBook({
        to: "reader@kindle.com",
        title: "The Borrowers",
        author: "Mary Norton",
        requestedBy: "Mum",
        filePath,
      });

      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(result).toBe("Sent book-1024.epub to reader@kindle.com.");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects files that exceed the configured attachment limit before SMTP send", async () => {
    process.env.SMTP_MAX_ATTACHMENT_BYTES = "1024";
    resetAppConfigCache();

    const { filePath, tempDir } = await createTempBookFile(2048);
    const sendMail = vi.fn(async () => ({ messageId: "message-2" }));
    const mailer = createSmtpMailer({
      transporter: {
        sendMail,
        verify: vi.fn(async () => true),
      } as never,
    });

    try {
      await expect(
        mailer.sendBook({
          to: "reader@kindle.com",
          title: "The Borrowers",
          author: "Mary Norton",
          requestedBy: "Mum",
          filePath,
        }),
      ).rejects.toThrow(
        '"book-2048.epub" is 2.0 KB, which is over the safe email attachment limit of 1.0 KB.',
      );
      expect(sendMail).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
