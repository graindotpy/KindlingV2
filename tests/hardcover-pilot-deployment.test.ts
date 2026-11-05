import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const pilotRoot = path.join(repositoryRoot, "deploy", "hardcover-pilot");
const composePath = path.join(pilotRoot, "compose.yaml");
const localScriptPath = path.join(pilotRoot, "Deploy-HardcoverPilot.ps1");
const remoteScriptPath = path.join(pilotRoot, "deploy-zimaos.sh");
const patchPath = path.join(
  pilotRoot,
  "patches",
  "0001-limit-hardcover-graphql-batches.patch",
);
const envExamplePath = path.join(pilotRoot, "pilot.env.example");

const APPROVED_UPSTREAM_COMMIT = "a2939b625d91389d3f0a3e58cbc3bfa7ebb8390a";
const BOOKSHELF_IMAGE =
  "ghcr.io/pennydreadful/bookshelf:hardcover-v0.4.20.129@sha256:388eecc94362580eae31ee0a454be6af516f8a311f8432a521c202fb475f4359";
const POSTGRES_IMAGE =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function readPilotFiles() {
  const [compose, localScript, remoteScript, reliabilityPatch, envExample] =
    await Promise.all([
      fs.readFile(composePath, "utf8"),
      fs.readFile(localScriptPath, "utf8"),
      fs.readFile(remoteScriptPath, "utf8"),
      fs.readFile(patchPath, "utf8"),
      fs.readFile(envExamplePath, "utf8"),
    ]);

  return { compose, localScript, remoteScript, reliabilityPatch, envExample };
}

describe("isolated Hardcover pilot deployment", () => {
  it("pins every external source and image to an immutable identity", async () => {
    const { compose, localScript, remoteScript, reliabilityPatch } =
      await readPilotFiles();

    expect(compose).toContain(`image: ${BOOKSHELF_IMAGE}`);
    expect(compose).toContain(`image: ${POSTGRES_IMAGE}`);
    expect(remoteScript).toContain(`BOOKSHELF_IMAGE="${BOOKSHELF_IMAGE}"`);
    expect(remoteScript).toContain(`POSTGRES_IMAGE="${POSTGRES_IMAGE}"`);
    expect(localScript).toContain(
      `[string]$UpstreamCommit = "${APPROVED_UPSTREAM_COMMIT}"`,
    );
    expect(remoteScript).toContain(
      `EXPECTED_UPSTREAM_COMMIT="${APPROVED_UPSTREAM_COMMIT}"`,
    );
    expect(localScript).toContain("checkout\", \"--detach");
    expect(localScript).toContain("rev-parse HEAD");
    expect(localScript).toContain("$resolvedCommit -ne $UpstreamCommit");

    expect(compose).not.toMatch(/image:\s*[^\r\n]+:(?:latest|develop)(?:\s|$)/i);
    expect(reliabilityPatch).toMatch(
      /FROM --platform=\$BUILDPLATFORM golang:[^\s]+@sha256:[0-9a-f]{64}/,
    );
    expect(reliabilityPatch).toMatch(
      /FROM gcr\.io\/distroless\/static:nonroot@sha256:[0-9a-f]{64}/,
    );
  });

  it("keeps the pilot isolated from live names, storage, ports, and networks", async () => {
    const { compose, localScript, envExample } = await readPilotFiles();

    expect(compose).toContain("name: kindling-bookshelf-hardcover-pilot");
    expect(localScript).toContain(
      '[string]$RemoteAppDir = "/DATA/AppData/kindling-bookshelf-hardcover-pilot"',
    );
    expect(compose).toContain("container_name: kindling-hc-pilot-ebook");
    expect(compose).toContain("container_name: kindling-hc-pilot-audiobook");
    expect(compose).toContain("container_name: kindling-hc-pilot-metadata");
    expect(compose).toContain("container_name: kindling-hc-pilot-postgres");

    expect(envExample).toMatch(/^PILOT_BIND_ADDRESS=127\.0\.0\.1$/m);
    expect(envExample).toMatch(/^PILOT_EBOOK_PORT=18787$/m);
    expect(envExample).toMatch(/^PILOT_AUDIOBOOK_PORT=18788$/m);
    expect(envExample).toMatch(/^PILOT_METADATA_PORT=18789$/m);
    expect(compose).toContain("${PILOT_BIND_ADDRESS:?Set PILOT_BIND_ADDRESS}");
    expect(compose).toContain('"127.0.0.1:${PILOT_METADATA_PORT:-18789}:8788"');

    expect(compose).toContain("./data/config/ebook:/config");
    expect(compose).toContain("./data/config/audiobook:/config");
    expect(compose).toContain("./data/library/ebooks:/books");
    expect(compose).toContain("./data/library/audiobooks:/books");
    expect(compose).toContain("./data/postgres:/var/lib/postgresql/data");
    expect(compose).toMatch(/metadata_private:\s*\r?\n\s+internal: true/);

    const postgresBlock = compose.match(
      /\n  postgres:\r?\n([\s\S]*?)\nsecrets:/,
    )?.[1];
    expect(postgresBlock).toBeTruthy();
    expect(postgresBlock).not.toMatch(/\n\s+ports:/);
    expect(postgresBlock).toMatch(/networks:\s*\r?\n\s+- metadata_private/);
    expect(compose).not.toMatch(/container_name:\s*(?:kindling|readarr|Readarr-Audio)\s*$/m);
    expect(compose).not.toContain("/DATA/AppData/kindling/data");
  });

  it("uses root-owned secret files and keeps credentials out of Compose and env files", async () => {
    const { compose, localScript, remoteScript, envExample } = await readPilotFiles();

    expect(compose).toContain("HARDCOVER_AUTH_FILE: /run/secrets/hardcover_auth");
    expect(compose).toContain("POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password");
    expect(compose).toContain("file: ./secrets/hardcover_auth");
    expect(compose).toContain("file: ./secrets/postgres_password");
    expect(compose).not.toMatch(/^\s*(?:HARDCOVER_AUTH|POSTGRES_PASSWORD):/m);
    expect(envExample).not.toMatch(/^(?:HARDCOVER_AUTH|POSTGRES_PASSWORD)=/m);

    expect(remoteScript).toContain("stat -c '%u'");
    expect(remoteScript).toContain("stat -c '%a'");
    expect(remoteScript).toContain("== 0");
    expect(remoteScript).toContain("== 600");
    expect(remoteScript).toContain("Secrets must not be stored in the pilot .env file.");
    expect(remoteScript).toMatch(/grep -Eq '\^Bearer\[\[:space:\]\]/);
    expect(localScript).toMatch(/\(\^\|\/\)secrets\?\(\/\|\$\)/);
  });

  it("owns and verifies the Hardcover five-query batch-limit patch", async () => {
    const { compose, localScript, remoteScript, reliabilityPatch } =
      await readPilotFiles();

    expect(compose).toContain('HARDCOVER_BATCH_SIZE: "5"');
    expect(reliabilityPatch).toContain(
      'HardcoverBatchSize int    `default:"5" env:"HARDCOVER_BATCH_SIZE"',
    );
    expect(reliabilityPatch).toContain("s.HardcoverBatchSize < 1");
    expect(reliabilityPatch).toContain("s.HardcoverBatchSize > 5");
    expect(reliabilityPatch).toContain("s.HardcoverBatchSize, reg");
    expect(reliabilityPatch).toContain("RUN go test ./cmd/rghc ./internal");
    expect(localScript).toContain('"apply", "--check", $patchPath');
    expect(localScript).toContain("HARDCOVER_BATCH_SIZE");
    expect(remoteScript).toContain("Patched metadata source is missing the batch-size control.");
    expect(remoteScript).toContain("Patched metadata source does not enforce the Hardcover ceiling.");
  });

  it("verifies archive provenance and excludes private or mutable local state", async () => {
    const { localScript, remoteScript } = await readPilotFiles();

    expect(localScript).toContain("--exclude=rreading-glasses/.git");
    expect(localScript).toContain("SOURCE_MANIFEST.txt");
    expect(localScript).toContain("upstream_commit=$UpstreamCommit");
    expect(localScript).toContain("patch_sha256=$patchSha256");
    expect(localScript).toContain("Get-FileHash");
    expect(localScript).toMatch(/\(\^\|\/\)\\\.env\(\$\|\\\.\)/);
    expect(localScript).not.toContain("Invoke-Expression");

    expect(remoteScript).toContain("set -Eeuo pipefail");
    expect(remoteScript).toContain("ACTUAL_SHA256=$(sha256sum");
    expect(remoteScript).toContain("Archive SHA-256 does not match the local package.");
    expect(remoteScript).toContain("Uploaded helper does not match the verified source archive.");
    expect(remoteScript).toContain(
      'grep -Fxq "upstream_commit=$EXPECTED_UPSTREAM_COMMIT"',
    );
    expect(remoteScript).toContain("Archive contains Git internals.");
    expect(remoteScript).toContain("Archive contains a private environment file.");
    expect(remoteScript).toContain("Archive contains a secrets directory.");
    expect(remoteScript).not.toMatch(/\beval\b/);
  });

  it("rolls back images and Compose without deleting persistent volumes", async () => {
    const { remoteScript } = await readPilotFiles();

    expect(remoteScript).toContain("rollback_deployment()");
    expect(remoteScript).toContain("compose-before-$RELEASE_ID.yaml");
    expect(remoteScript).toContain('docker image tag "$PREVIOUS_IMAGE_ID" "$ROLLBACK_IMAGE"');
    expect(remoteScript).toContain('docker image tag "$PREVIOUS_IMAGE_ID" "$ACTIVE_IMAGE"');
    expect(remoteScript).toContain("compose down --remove-orphans");
    expect(remoteScript).toContain("compose up -d --no-build");

    expect(remoteScript).not.toMatch(/compose\s+down[^\r\n]*(?:--volumes|-v)(?:\s|$)/);
    expect(remoteScript).not.toMatch(/docker\s+volume\s+(?:rm|prune)/);
    expect(remoteScript).not.toMatch(/docker\s+(?:system|image|builder)\s+prune/);
    expect(remoteScript).not.toMatch(/rm\s+-rf[^\r\n]*(?:\$APP_DIR|\/DATA\/AppData)/);
  });

  it.skipIf(process.platform !== "win32")(
    "parses in Windows PowerShell 5.1",
    async () => {
      const parseCommand = [
        "$tokens=$null; $errors=$null;",
        `[System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(localScriptPath)}, [ref]$tokens, [ref]$errors) | Out-Null;`,
        "if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }",
      ].join(" ");

      await execute(
        "powershell.exe",
        ["-NoProfile", "-Command", parseCommand],
        { timeout: 10_000 },
      );
    },
  );

  it.skipIf(process.platform !== "win32")(
    "creates a source-pinned, private-data-free archive in an offline dry run",
    async () => {
      const fakeCommands = await fs.mkdtemp(
        path.join(os.tmpdir(), "kindling-hardcover-pilot-tools-"),
      );
      temporaryDirectories.push(fakeCommands);

      const fakeGitScript = path.join(fakeCommands, "fake-git.ps1");
      await fs.writeFile(
        fakeGitScript,
        [
          "$ErrorActionPreference = 'Stop'",
          `$commit = '${APPROVED_UPSTREAM_COMMIT}'`,
          "if ($args[0] -eq 'clone') {",
          "  $destination = $args[$args.Count - 1]",
          "  New-Item -ItemType Directory -Force -Path (Join-Path $destination 'cmd/rghc') | Out-Null",
          "  Set-Content -LiteralPath (Join-Path $destination 'Dockerfile') -Value 'FROM scratch' -NoNewline",
          "  $main = 'HARDCOVER_BATCH_SIZE; if s.HardcoverBatchSize < 1 || s.HardcoverBatchSize > 5 {}'",
          "  Set-Content -LiteralPath (Join-Path $destination 'cmd/rghc/main.go') -Value $main -NoNewline",
          "  exit 0",
          "}",
          "if ($args -contains 'rev-parse') { Write-Output $commit; exit 0 }",
          "exit 0",
        ].join("\r\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(fakeCommands, "git.cmd"),
        '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0fake-git.ps1" %*\r\nexit /b %ERRORLEVEL%\r\n',
        "utf8",
      );

      const { stdout } = await execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          localScriptPath,
          "-DryRun",
          "-KeepLocalArtifacts",
        ],
        {
          cwd: repositoryRoot,
          env: { ...process.env, PATH: `${fakeCommands};${process.env.PATH}` },
          timeout: 30_000,
        },
      );

      const archivePath = stdout.match(/^PILOT_DEPLOY_ARCHIVE=(.+)$/m)?.[1]?.trim();
      expect(archivePath).toBeTruthy();
      temporaryDirectories.push(path.dirname(archivePath!));

      const { stdout: manifestOutput } = await execute(
        "tar.exe",
        ["-tzf", archivePath!],
        { cwd: repositoryRoot, timeout: 10_000 },
      );
      const entries = manifestOutput.split(/\r?\n/).filter(Boolean);
      expect(entries).toContain("SOURCE_MANIFEST.txt");
      expect(entries).toContain("compose.yaml");
      expect(entries).toContain("pilot.env.example");
      expect(entries).toContain("deploy-zimaos.sh");
      expect(entries).toContain("rreading-glasses/Dockerfile");
      expect(entries).toContain("rreading-glasses/cmd/rghc/main.go");
      expect(entries.some((entry) => /(^|\/)\.git(\/|$)/.test(entry))).toBe(false);
      expect(entries.some((entry) => /(^|\/)\.env($|\.)/.test(entry))).toBe(false);
      expect(entries.some((entry) => /(^|\/)secrets?(\/|$)/i.test(entry))).toBe(false);

      const { stdout: sourceManifest } = await execute(
        "tar.exe",
        ["-xOf", archivePath!, "SOURCE_MANIFEST.txt"],
        { cwd: repositoryRoot, timeout: 10_000 },
      );
      expect(sourceManifest).toContain(`upstream_commit=${APPROVED_UPSTREAM_COMMIT}`);
      expect(sourceManifest).toMatch(/^patch_sha256=[0-9a-f]{64}$/m);
    },
    40_000,
  );

  it.skipIf(process.platform === "win32")(
    "has valid Bash syntax on the deployment host platform",
    async () => {
      await execute("bash", ["-n", remoteScriptPath], {
        cwd: repositoryRoot,
        timeout: 10_000,
      });
    },
  );
});
