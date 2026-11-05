import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const powerShellScript = path.join(repositoryRoot, "deploy", "Deploy-Kindling.ps1");
const remoteScript = path.join(repositoryRoot, "deploy", "deploy-zimaos.sh");

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("deployment automation", () => {
  it("keeps backup, integrity, locking, health, and immutable rollback safeguards", async () => {
    const [localSource, remoteSource] = await Promise.all([
      fs.readFile(powerShellScript, "utf8"),
      fs.readFile(remoteScript, "utf8"),
    ]);

    expect(localSource).toContain("Assert-SafeArchive");
    expect(localSource).toContain("Get-FileHash");
    expect(localSource).not.toContain("Invoke-Expression");
    expect(remoteSource).toContain("set -Eeuo pipefail");
    expect(remoteSource).toContain("Another Kindling deployment is already running");
    expect(remoteSource).toContain("Backup integrity check failed");
    expect(remoteSource).toContain("docker inspect --format '{{.Image}}'");
    expect(remoteSource).toContain("wait_for_health");
    expect(remoteSource).toContain("rollback_deployment");
    expect(remoteSource).not.toMatch(/docker\s+(?:system|image|volume|builder)\s+prune/);
    expect(remoteSource).not.toMatch(/\beval\b/);
  });

  it.skipIf(process.platform !== "win32")(
    "parses in Windows PowerShell 5.1 and produces a private-data-free dry-run archive",
    async () => {
      const parseCommand = [
        "$tokens=$null; $errors=$null;",
        `[System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(powerShellScript)}, [ref]$tokens, [ref]$errors) | Out-Null;`,
        "if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }",
      ].join(" ");
      await execute("powershell.exe", ["-NoProfile", "-Command", parseCommand], { timeout: 10_000 });

      const { stdout } = await execute("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", powerShellScript,
        "-SkipChecks",
        "-DryRun",
        "-KeepLocalArtifacts",
      ], { cwd: repositoryRoot, timeout: 20_000 });

      const archiveMatch = stdout.match(/^DEPLOY_ARCHIVE=(.+)$/m);
      expect(archiveMatch?.[1]).toBeTruthy();
      const archivePath = archiveMatch![1].trim();
      temporaryDirectories.push(path.dirname(archivePath));
      expect(path.basename(archivePath)).toMatch(/^kindling-deploy-\d{8}-\d{6}-[a-f0-9]{12}\.tar\.gz$/);

      const { stdout: manifest } = await execute("tar.exe", ["-tzf", archivePath], {
        cwd: repositoryRoot,
        timeout: 10_000,
      });
      const entries = manifest.split(/\r?\n/).filter(Boolean);

      expect(entries).toContain(".env.example");
      expect(entries).toContain("deploy/Deploy-Kindling.ps1");
      expect(entries).toContain("deploy/deploy-zimaos.sh");
      expect(entries.some((entry) =>
        /(^|\/)\.env($|\.)/.test(entry) && entry !== ".env.example",
      )).toBe(false);
      expect(entries.some((entry) =>
        /(^|\/)(data|dist|node_modules|\.next|\.git)(\/|$)/.test(entry),
      )).toBe(false);
      expect(entries.some((entry) => /(^|\/)\.\.($|\/)/.test(entry))).toBe(false);

      const releaseStem = path.basename(archivePath, ".tar.gz");
      const uploadedHelper = await fs.readFile(path.join(path.dirname(archivePath), `${releaseStem}.sh`), "utf8");
      const { stdout: archivedHelper } = await execute("tar.exe", [
        "-xOf", archivePath, "deploy/deploy-zimaos.sh",
      ], { cwd: repositoryRoot, timeout: 10_000 });
      expect(uploadedHelper).toBe(archivedHelper);
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "rejects an unsafe SSH target before packaging or connecting",
    async () => {
      await expect(execute("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", powerShellScript,
        "-SkipChecks",
        "-DryRun",
        "-Target", "admin@server;touch-pwned",
      ], { cwd: repositoryRoot, timeout: 10_000 })).rejects.toMatchObject({ code: 1 });
    },
  );

  it.skipIf(process.platform !== "win32")(
    "uploads once and invokes the validated remote helper through sudo",
    async () => {
      const fakeCommands = await fs.mkdtemp(path.join(process.env.TEMP!, "kindling-deploy-tools-"));
      temporaryDirectories.push(fakeCommands);
      const callLog = path.join(fakeCommands, "calls.log");
      await Promise.all([
        fs.writeFile(path.join(fakeCommands, "scp.cmd"), "@echo scp %*>>\"%KINDLING_DEPLOY_TEST_LOG%\"\r\n@exit /b 0\r\n"),
        fs.writeFile(path.join(fakeCommands, "ssh.cmd"), "@echo ssh %*>>\"%KINDLING_DEPLOY_TEST_LOG%\"\r\n@exit /b 0\r\n"),
      ]);

      await execute("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", powerShellScript,
        "-SkipChecks",
      ], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${fakeCommands};${process.env.PATH}`,
          KINDLING_DEPLOY_TEST_LOG: callLog,
        },
        timeout: 20_000,
      });

      const calls = await fs.readFile(callLog, "utf8");
      expect(calls.match(/^scp /gm)).toHaveLength(1);
      expect(calls.match(/^ssh /gm)).toHaveLength(1);
      expect(calls).toMatch(/scp .*kindling-deploy-[0-9-]+-[a-f0-9]{12}\.tar\.gz .*kindling-deploy-[0-9-]+-[a-f0-9]{12}\.sh admin@192\.168\.4\.148:\/tmp\//);
      expect(calls).toContain("admin@192.168.4.148:/tmp/");
      expect(calls).toContain("sudo /bin/bash /tmp/kindling-deploy-");
      expect(calls).toContain("--app-dir /DATA/AppData/kindling");
      expect(calls).toContain("--health-timeout 150");
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "has valid Bash syntax on the deployment host platform",
    async () => {
      await execute("bash", ["-n", remoteScript], { cwd: repositoryRoot, timeout: 10_000 });
    },
  );
});
