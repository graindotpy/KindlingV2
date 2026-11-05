import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Exported so lifecycle behavior can be tested without starting the real app.
export async function supervise({
  initialize = ["dist/init.cjs"],
  services = [["server.js"], ["dist/worker.cjs"]],
  cwd = process.cwd(),
  env = process.env,
  shutdownTimeoutMs = 35_000,
} = {}) {
  const children = new Set();
  let stopping = false;
  let exitCode = 0;
  let forceTimer;

  const finish = () => {
    if (stopping && children.size === 0) {
      clearTimeout(forceTimer);
    }
  };
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const child of children) child.kill("SIGTERM");
    forceTimer = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, shutdownTimeoutMs);
    forceTimer.unref();
    finish();
  };
  const onSignal = () => stop(0);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const launch = (args, persistent) => new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...env, KINDLING_EMBEDDED_WORKER: "false" },
      stdio: "inherit",
    });
    children.add(child);
    let settled = false;
    const complete = (code, signal, error) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      if (error) console.error(`[kindling] Could not start ${args[0]}: ${error.message}`);
      if (!stopping && (persistent || code !== 0)) {
        console.error(`[kindling] ${args[0]} stopped (${signal ?? code ?? "error"}). Shutting down.`);
        stop(1);
      }
      finish();
      resolve(code ?? 1);
    };
    child.once("error", (error) => complete(1, null, error));
    child.once("exit", (code, signal) => complete(code, signal));
  });

  try {
    await launch(initialize, false);
    if (!stopping) {
      console.log("[kindling] Starting web app and background worker.");
      await Promise.all(services.map((args) => launch(args, true)));
    }
    return exitCode;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    clearTimeout(forceTimer);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await supervise();
}
