import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { getAppConfig, isSmtpConfigured } from "@/lib/config";

export type SendBookEmailInput = {
  to: string;
  title: string;
  author: string;
  requestedBy: string;
  filePath: string;
};

export interface KindleMailer {
  isConfigured(): boolean;
  checkConnection(): Promise<{
    configured: boolean;
    reachable: boolean;
    message: string;
  }>;
  sendBook(input: SendBookEmailInput): Promise<string>;
}

type CreateSmtpMailerDependencies = {
  transporter?: Transporter;
};

function getTransporter(config: ReturnType<typeof getAppConfig>) {
  const { host, port, secure, username, password } = config.delivery.smtp;

  return nodemailer.createTransport({
    host: host ?? undefined,
    port,
    secure,
    auth: username && password ? { user: username, pass: password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export function createSmtpMailer(
  deps: CreateSmtpMailerDependencies = {},
): KindleMailer {
  const config = getAppConfig();
  const transporter = deps.transporter ?? getTransporter(config);

  return {
    isConfigured() {
      return isSmtpConfigured();
    },

    async checkConnection() {
      if (!this.isConfigured()) {
        return {
          configured: false,
          reachable: false,
          message:
            "Add SMTP_HOST, SMTP_FROM_EMAIL, and matching SMTP credentials to enable Kindle delivery.",
        };
      }

      try {
        await transporter.verify();
        return {
          configured: true,
          reachable: true,
          message: "Connected to SMTP and ready to send Kindle deliveries.",
        };
      } catch (error) {
        return {
          configured: true,
          reachable: false,
          message:
            error instanceof Error
              ? error.message
              : "Kindling could not verify the SMTP server.",
        };
      }
    },

    async sendBook(input) {
      if (!this.isConfigured()) {
        throw new Error("SMTP is not configured yet for Kindle delivery.");
      }

      const fromEmail = config.delivery.smtp.fromEmail;
      if (!fromEmail) {
        throw new Error("SMTP from email is missing.");
      }

      await transporter.sendMail({
        from: fromEmail,
        to: input.to,
        subject: `${input.title} from Kindling`,
        text: `Kindling found "${input.title}" by ${input.author} for ${input.requestedBy}.`,
        attachments: [
          {
            filename: path.basename(input.filePath),
            path: input.filePath,
          },
        ],
      });

      return `Sent ${path.basename(input.filePath)} to ${input.to}.`;
    },
  };
}
