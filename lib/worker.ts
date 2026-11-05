import { startBackgroundWorker, stopBackgroundWorker } from "@/lib/bootstrap";

// Keep the standalone worker process alive while the internal scan timer is unref'd.
const keepAlive = setInterval(() => {}, 2_147_483_647);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(keepAlive);
  // Give an in-flight delivery time to record its result before the process exits.
  const timeout = setTimeout(() => process.exit(1), 30_000);
  try {
    await stopBackgroundWorker();
    clearTimeout(timeout);
    process.exit(process.exitCode ?? 0);
  } catch (error) {
    console.error("[kindling worker] Shutdown failed:", error);
    process.exit(1);
  }
};

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

startBackgroundWorker(() => {
  process.exitCode = 1;
  void shutdown();
});
