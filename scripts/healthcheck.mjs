try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || "3000"}/api/health/live`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const health = await response.json();
  if (health.app !== "ok" || health.database !== "ok" || health.worker !== "ok") {
    throw new Error("The app, database, or background worker is unavailable.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Health check failed.");
  process.exitCode = 1;
}
