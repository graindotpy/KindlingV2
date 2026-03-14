import path from "node:path";
import { z } from "zod";
import type { BookRequestFormat } from "@/lib/requests/types";

const optionalString = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}, z.string().optional());

const optionalPositiveInteger = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return Number(value);
}, z.number().int().positive().optional());

const optionalBoolean = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }

    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }

  return value;
}, z.boolean().optional());

const envSchema = z.object({
  DATABASE_PATH: z.string().trim().default("./data/kindling.db"),
  READARR_BASE_URL: optionalString,
  READARR_API_KEY: optionalString,
  READARR_ROOT_FOLDER_PATH: optionalString,
  READARR_QUALITY_PROFILE_ID: optionalPositiveInteger,
  READARR_METADATA_PROFILE_ID: optionalPositiveInteger,
  AUDIOBOOK_READARR_BASE_URL: optionalString,
  AUDIOBOOK_READARR_API_KEY: optionalString,
  AUDIOBOOK_READARR_ROOT_FOLDER_PATH: optionalString,
  AUDIOBOOK_READARR_QUALITY_PROFILE_ID: optionalPositiveInteger,
  AUDIOBOOK_READARR_METADATA_PROFILE_ID: optionalPositiveInteger,
  READARR_SYNC_INTERVAL_SECONDS: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return 120;
    }

    return Number(value);
  }, z.number().int().min(30).max(3600)),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return 587;
    }

    return Number(value);
  }, z.number().int().min(1).max(65535)),
  SMTP_SECURE: optionalBoolean.default(false),
  SMTP_USERNAME: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM_EMAIL: optionalString,
  SMTP_MAX_ATTACHMENT_BYTES: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return 18 * 1024 * 1024;
    }

    return Number(value);
  }, z.number().int().positive()),
  KINDLING_ADMIN_PASSWORD: optionalString,
  KINDLING_SESSION_SECRET: optionalString,
  KINDLING_SESSION_TTL_HOURS: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return 168;
    }

    return Number(value);
  }, z.number().int().min(1).max(24 * 365)),
  KINDLING_EMBEDDED_WORKER: optionalBoolean.default(false),
  DELIVERY_SCAN_INTERVAL_SECONDS: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return 60;
    }

    return Number(value);
  }, z.number().int().min(15).max(3600)),
});

export type ReadarrInstanceConfig = {
  baseUrl: string | null;
  apiKey: string | null;
  rootFolderPath: string | null;
  qualityProfileId: number | null;
  metadataProfileId: number | null;
};

export type AppConfig = {
  databasePath: string;
  syncIntervalMs: number;
  readarr: Record<BookRequestFormat, ReadarrInstanceConfig>;
  auth: {
    password: string | null;
    sessionSecret: string | null;
    sessionTtlMs: number;
  };
  worker: {
    embedded: boolean;
  };
  delivery: {
    scanIntervalMs: number;
    smtp: {
      host: string | null;
      port: number;
      secure: boolean;
      username: string | null;
      password: string | null;
      fromEmail: string | null;
      maxAttachmentBytes: number;
    };
  };
};

let cachedConfig: AppConfig | null = null;

export function getAppConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = envSchema.parse(process.env);

  cachedConfig = {
    databasePath: path.resolve(process.cwd(), parsed.DATABASE_PATH),
    syncIntervalMs: parsed.READARR_SYNC_INTERVAL_SECONDS * 1000,
    readarr: {
      ebook: {
        baseUrl: parsed.READARR_BASE_URL?.replace(/\/+$/, "") ?? null,
        apiKey: parsed.READARR_API_KEY ?? null,
        rootFolderPath: parsed.READARR_ROOT_FOLDER_PATH ?? null,
        qualityProfileId: parsed.READARR_QUALITY_PROFILE_ID ?? null,
        metadataProfileId: parsed.READARR_METADATA_PROFILE_ID ?? null,
      },
      audiobook: {
        baseUrl: parsed.AUDIOBOOK_READARR_BASE_URL?.replace(/\/+$/, "") ?? null,
        apiKey: parsed.AUDIOBOOK_READARR_API_KEY ?? null,
        rootFolderPath: parsed.AUDIOBOOK_READARR_ROOT_FOLDER_PATH ?? null,
        qualityProfileId: parsed.AUDIOBOOK_READARR_QUALITY_PROFILE_ID ?? null,
        metadataProfileId: parsed.AUDIOBOOK_READARR_METADATA_PROFILE_ID ?? null,
      },
    },
    auth: {
      password: parsed.KINDLING_ADMIN_PASSWORD ?? null,
      sessionSecret: parsed.KINDLING_SESSION_SECRET ?? null,
      sessionTtlMs: parsed.KINDLING_SESSION_TTL_HOURS * 60 * 60 * 1000,
    },
    worker: {
      embedded: parsed.KINDLING_EMBEDDED_WORKER,
    },
    delivery: {
      scanIntervalMs: parsed.DELIVERY_SCAN_INTERVAL_SECONDS * 1000,
      smtp: {
        host: parsed.SMTP_HOST ?? null,
        port: parsed.SMTP_PORT,
        secure: parsed.SMTP_SECURE,
        username: parsed.SMTP_USERNAME ?? null,
        password: parsed.SMTP_PASSWORD ?? null,
        fromEmail: parsed.SMTP_FROM_EMAIL ?? null,
        maxAttachmentBytes: parsed.SMTP_MAX_ATTACHMENT_BYTES,
      },
    },
  };

  return cachedConfig;
}

export function getReadarrConfig(format: BookRequestFormat = "ebook") {
  return getAppConfig().readarr[format];
}

export function isReadarrConfigured(format: BookRequestFormat = "ebook") {
  const config = getReadarrConfig(format);
  return Boolean(config.baseUrl && config.apiKey);
}

export function isAnyReadarrConfigured() {
  const config = getAppConfig();
  return Object.values(config.readarr).some(
    (instance) => Boolean(instance.baseUrl && instance.apiKey),
  );
}

export function isSmtpConfigured() {
  const config = getAppConfig();
  const { host, fromEmail, username, password } = config.delivery.smtp;

  if (!host || !fromEmail) {
    return false;
  }

  if ((username && !password) || (!username && password)) {
    return false;
  }

  return true;
}

export function resetAppConfigCache() {
  cachedConfig = null;
}
