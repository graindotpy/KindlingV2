import { startBackgroundWorker, stopBackgroundWorker } from "@/lib/bootstrap";

startBackgroundWorker();

const shutdown = () => {
  stopBackgroundWorker();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise(() => {});
