import path from "node:path";
import { z } from "zod";

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

const envSchema = z.object({
  DATABASE_PATH: z.string().trim().default("./data/kindling.db"),
  READARR_BASE_URL: optionalString,
  READARR_API_KEY: optionalString,
  READARR_ROOT_FOLDER_PATH: optionalString,
  READARR_QUALITY_PROFILE_ID: optionalPositiveInteger,
  READARR_METADATA_PROFILE_ID: optionalPositiveInteger,
  READARR_SYNC_INTERVAL_SECONDS: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return 120;
    }

    return Number(value);
  }, z.number().int().min(30).max(3600)),
});

export type AppConfig = {
  databasePath: string;
  syncIntervalMs: number;
  readarr: {
    baseUrl: string | null;
    apiKey: string | null;
    rootFolderPath: string | null;
    qualityProfileId: number | null;
    metadataProfileId: number | null;
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
      baseUrl: parsed.READARR_BASE_URL?.replace(/\/+$/, "") ?? null,
      apiKey: parsed.READARR_API_KEY ?? null,
      rootFolderPath: parsed.READARR_ROOT_FOLDER_PATH ?? null,
      qualityProfileId: parsed.READARR_QUALITY_PROFILE_ID ?? null,
      metadataProfileId: parsed.READARR_METADATA_PROFILE_ID ?? null,
    },
  };

  return cachedConfig;
}

export function isReadarrConfigured() {
  const config = getAppConfig();
  return Boolean(config.readarr.baseUrl && config.readarr.apiKey);
}
