import { build } from "esbuild";

await build({
  entryPoints: {
    worker: "lib/worker.ts",
    init: "scripts/init.ts",
    backup: "scripts/backup.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // Native SQLite and Nodemailer's runtime assets are in Next's standalone trace.
  external: ["better-sqlite3", "nodemailer"],
  logLevel: "info",
});
