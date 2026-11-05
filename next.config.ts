import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingIncludes: {
    "/*": ["lib/db/migrations/*.sql", "node_modules/nodemailer/**/*"],
  },
  outputFileTracingExcludes: {
    "/*": [
      ".env*",
      "data/**/*",
      "watched-books/**/*",
      "tests/**/*",
      "test-results/**/*",
      "playwright-report/**/*",
      "coverage/**/*",
      "**/*.db",
      "**/*.db-*",
      "**/*.sqlite",
      "**/*.sqlite-*",
    ],
  },
};

export default nextConfig;
