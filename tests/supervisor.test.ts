import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { supervise } from "../scripts/start.mjs";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kindling-supervisor-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("container process supervisor", () => {
  it("does not launch services when database initialization fails", async () => {
    const directory = await temporaryDirectory();
    const marker = path.join(directory, "started");
    const code = await supervise({
      initialize: ["-e", "process.exit(7)"],
      services: [["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`]],
      shutdownTimeoutMs: 500,
    });
    expect(code).toBe(1);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it("terminates the other service and exits unsuccessfully if either service exits", async () => {
    const directory = await temporaryDirectory();
    const pidFile = path.join(directory, "pid");
    const code = await supervise({
      initialize: ["-e", "process.exit(0)"],
      services: [
        ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`],
        ["-e", "setTimeout(() => process.exit(0), 200)"],
      ],
      shutdownTimeoutMs: 500,
    });
    expect(code).toBe(1);
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("forwards shutdown signals to all children", async () => {
    const runner = `import { supervise } from ${JSON.stringify(new URL("../scripts/start.mjs", import.meta.url).href)};
      const services = [['-e', 'setInterval(() => {}, 1000)'], ['-e', 'setInterval(() => {}, 1000)']];
      setTimeout(() => process.emit('SIGTERM'), 250);
      process.exitCode = await supervise({ initialize: ['-e', 'process.exit(0)'], services, shutdownTimeoutMs: 500 });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", runner], { stdio: "pipe" });
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
  });
});
