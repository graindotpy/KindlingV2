import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { getAppConfig } from "@/lib/config";

async function main() {
  const databasePath = getAppConfig().databasePath;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.resolve(
    process.argv[2] ?? path.join(path.dirname(databasePath), "backups", `kindling-${stamp}.db`),
  );
  if (destination === databasePath) {
    throw new Error("The backup destination must differ from the live database.");
  }
  // A typo in DATABASE_PATH must not silently create and back up an empty database.
  // Backups do not apply migrations or otherwise modify the live database schema.
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  let reservedDestination = false;
  try {
    database.pragma("busy_timeout = 10000");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // Refuse to overwrite another backup. The backup API includes committed WAL data.
    const file = await fs.open(destination, "wx", 0o600);
    reservedDestination = true;
    await file.close();
    await database.backup(destination);
    console.log(`[kindling] Backup saved to ${destination}`);
  } catch (error) {
    // Never leave a partial file that looks like a successful backup.
    if (reservedDestination) await fs.unlink(destination);
    throw error;
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error("[kindling] Backup failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
