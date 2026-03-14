import { startBackgroundWorker, stopBackgroundWorker } from "@/lib/bootstrap";

startBackgroundWorker();

// Keep the standalone worker process alive while the internal scan timer is unref'd.
const keepAlive = setInterval(() => {}, 2_147_483_647);

const shutdown = () => {
  clearInterval(keepAlive);
  stopBackgroundWorker();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
