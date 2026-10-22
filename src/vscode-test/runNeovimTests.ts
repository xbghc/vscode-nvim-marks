/** Opt-in, offline E2E test using an installed vscode-neovim and native Neovim. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "../..");

function installedNeovimExtension(): string {
  const explicit = process.env.NVIM_MARKS_NEOVIM_EXTENSION;
  const base = path.join(os.homedir(), ".vscode", "extensions");
  const folder = explicit ?? (fs.existsSync(base)
    ? fs.readdirSync(base).filter((name) => name.startsWith("asvetliakov.vscode-neovim-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => path.join(base, name))[0]
    : undefined);
  if (!folder || !fs.existsSync(path.join(folder, "package.json"))) {
    throw new Error("Install vscode-neovim locally, or set NVIM_MARKS_NEOVIM_EXTENSION to its extension folder.");
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8"));
  if (`${manifest.publisher}.${manifest.name}` !== "asvetliakov.vscode-neovim") {
    throw new Error(`Not a vscode-neovim extension folder: ${folder}`);
  }
  return path.resolve(folder);
}

function cachedCode(directory: string, depth = 0): string | undefined {
  if (!fs.existsSync(directory)) return undefined;
  const candidates = process.platform === "win32" ? ["Code.exe", "Code - Insiders.exe"]
    : process.platform === "darwin"
      ? ["Visual Studio Code.app/Contents/MacOS/Electron", "Visual Studio Code - Insiders.app/Contents/MacOS/Electron"]
      : ["code", "code-insiders"];
  for (const name of candidates) {
    const executable = path.join(directory, name);
    if (fs.existsSync(executable)) return executable;
  }
  if (depth >= 3) return undefined;
  const folders = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !["resources", "node_modules", "user-data", "extensions"].includes(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  for (const folder of folders) {
    const executable = cachedCode(path.join(directory, folder.name), depth + 1);
    if (executable) return executable;
  }
  return undefined;
}

async function launch(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  // Own the process so a broken bridge cannot leave the runner waiting forever.
  // All processes killed on timeout descend from this isolated test instance.
  const child = spawn(executable, args, {
    env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      if (child.pid) {
        if (process.platform === "win32") {
          spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      }
      finish(new Error("Real Neovim E2E test exceeded its 90 second process timeout."));
    }, 90000);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => finish(code === 0 ? undefined : new Error(`VS Code test exited with ${code ?? signal}.`)));
  });
}

async function main(): Promise<void> {
  const neovimExtension = installedNeovimExtension();
  const executable = process.env.VSCODE_EXECUTABLE_PATH ?? cachedCode(path.join(root, ".vscode-test"));
  if (!executable || !fs.existsSync(executable)) {
    throw new Error("No cached VS Code found. Set VSCODE_EXECUTABLE_PATH to a local VS Code executable; this test never downloads one.");
  }
  const nvimExecutable = process.env.NVIM_MARKS_NEOVIM_EXECUTABLE ?? "nvim";
  const nvim = spawnSync(nvimExecutable, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (nvim.error || nvim.status !== 0) throw new Error("Native nvim must be available on PATH.");
  console.log(`Real bridge: ${path.basename(neovimExtension)}; ${nvim.stdout.split(/\r?\n/)[0]}`);
  console.log(`VS Code: ${executable}`);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nvim-marks-neovim-e2e-"));
  const workspace = path.join(temporary, "workspace");
  const userData = path.join(temporary, "user-data");
  const extensions = path.join(temporary, "extensions");
  let passed = false;
  try {
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(userData, "User"), { recursive: true });
    fs.mkdirSync(extensions);
    fs.cpSync(neovimExtension, path.join(extensions, path.basename(neovimExtension)), { recursive: true });
    fs.writeFileSync(path.join(workspace, "marks.txt"), "first line\nsecond line\nthird line\nfresh target line\nlast line\n");
    fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({
      "vscode-neovim.useWSL": false,
      [`vscode-neovim.neovimExecutablePaths.${process.platform}`]: nvimExecutable,
      [`vscode-neovim.neovimInitVimPaths.${process.platform}`]: path.join(root, "test", "vscode-neovim", "init.lua"),
      // Keep the default output-channel logger: upstream 1.20.1 reuses a
      // closed logPath file descriptor when its restart command runs.
      "nvimMarks.debounceMs": 60000,
      "extensions.experimental.affinity": { "asvetliakov.vscode-neovim": 0, "xbghc.nvim-marks": 0 },
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "workbench.startupEditor": "none",
      "security.workspace.trust.enabled": false,
      "telemetry.telemetryLevel": "off",
      "chat.disableAIFeatures": true,
      "update.mode": "none",
    }, null, 2));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NVIM_MARKS_TEST_WORKSPACE: workspace,
      NVIM_MARKS_NEOVIM_TEST_ROOT: temporary,
      NVIM_MARKS_REPOSITORY: root,
      NVIM_APPNAME: "nvim",
      XDG_CONFIG_HOME: path.join(temporary, "config"),
      XDG_DATA_HOME: path.join(temporary, "data"),
      XDG_STATE_HOME: path.join(temporary, "state"),
      XDG_CACHE_HOME: path.join(temporary, "cache"),
      NVIM_LOG_FILE: path.join(temporary, "nvim.log"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NEOVIM_DEBUG;
    await launch(executable, [
      workspace, "--new-window", "--no-sandbox", "--disable-gpu", "--disable-updates",
      "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
      "--disable-extension=github.copilot", "--disable-extension=github.copilot-chat", "--log=error",
      "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", "--no-cached-data",
      `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
      `--extensionDevelopmentPath=${root}`,
      `--extensionTestsPath=${path.join(__dirname, "neovimSuite.js")}`,
    ], env);
    const report = JSON.parse(fs.readFileSync(path.join(temporary, "result.json"), "utf8"));
    if (report.passed !== 5 || report.failed !== 0) throw new Error(`Incomplete E2E test result: ${JSON.stringify(report)}`);
    for (const result of report.results) console.log(`ok   ${result}`);
    console.log("5/5 real Neovim E2E tests passed");
    passed = true;
  } finally {
    if (passed) {
      // Validate the exact temporary target before recursively removing it.
      if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("nvim-marks-neovim-e2e-")) {
        throw new Error(`Unexpected temporary cleanup path: ${temporary}`);
      }
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } else {
      console.error(`Failure diagnostics retained at ${temporary}`);
    }
  }
}

main().catch((error) => {
  console.error("Real Neovim E2E tests failed:", error);
  process.exitCode = 1;
});
