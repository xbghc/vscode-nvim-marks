import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const NEOVIM = "asvetliakov.vscode-neovim";

/** Lua long strings preserve Unicode, backslashes and newlines without JSON escaping. */
function literal(value: string): string {
  let equals = "=";
  while (value.includes(`]${equals}]`)) equals += "=";
  return `[${equals}[\n${value}]${equals}]`;
}

async function execute(code: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      vscode.commands.executeCommand("vscode-neovim.lua", code),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for vscode-neovim.")), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Uses the public Lua command, including across extension hosts and WSL. */
export class NeovimBridge implements vscode.Disposable {
  private readonly token = randomUUID();
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private source = "";
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();
  private checking = false;
  private stopTask?: Promise<void>;
  private lastError?: string;
  state = "waiting for vscode-neovim";

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    this.subscriptions.push(
      vscode.commands.registerCommand("nvimMarks.bootstrap", (token: unknown) => {
        if (token === this.token) return this.configure();
        return undefined;
      }),
      vscode.commands.registerCommand("nvimMarks.bridgeStatus", (token: unknown, error: unknown) => {
        if (this.stopped || token !== this.token) return;
        if (typeof error === "string") this.failed(error);
        else {
          if (this.state !== "bundled Lua loaded") this.output.appendLine("bundled Lua loaded");
          this.state = "bundled Lua loaded";
          this.lastError = undefined;
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (["mapM", "mapBacktick", "debounceMs", "extraEvents"].some((key) => event.affectsConfiguration(`nvimMarks.${key}`))) {
          void this.configure();
        }
      }),
    );
  }

  async start(): Promise<void> {
    try {
      this.source = await readFile(this.context.asAbsolutePath("lua/nvim-marks/init.lua"), "utf8");
      const dependency = vscode.extensions.getExtension(NEOVIM);
      if (!dependency) throw new Error("Install and enable the vscode-neovim extension.");
      await dependency.activate();
      if (this.stopped) return;
      // vscode-neovim does not expose a public restart event. A small probe
      // detects a new Neovim session; the source is sent only when needed.
      this.timer = setInterval(() => { void this.check(); }, 5000);
      await this.configure();
    } catch (error) {
      this.failed(error);
    }
  }

  private failed(error: unknown): void {
    if (this.stopped) return;
    const message = error instanceof Error ? error.message : String(error);
    this.state = message;
    if (message === this.lastError) return;
    this.lastError = message;
    this.output.appendLine(`Lua bridge: ${message}`);
    void vscode.window.showWarningMessage(`Neovim Marks: ${message}`, "Show Status").then((choice) => {
      if (choice === "Show Status") void vscode.commands.executeCommand("nvimMarks.status");
    });
  }

  private async check(): Promise<void> {
    if (this.stopped || this.checking) return;
    this.checking = true;
    try {
      await execute(`
        local marks = package.loaded["nvim-marks"]
        if not marks or marks._owner ~= ${literal(this.token)} then
          require("vscode").action("nvimMarks.bootstrap", { args = { ${literal(this.token)} } })
        else
          require("vscode").action("nvimMarks.bridgeStatus", { args = { ${literal(this.token)}, false } })
        end
      `);
    } catch (error) {
      this.failed(error);
    } finally {
      this.checking = false;
    }
  }

  private configure(): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (this.stopped || !this.source) return;
      const config = vscode.workspace.getConfiguration("nvimMarks");
      const options = {
        map_m: config.get("mapM", true),
        map_backtick: config.get("mapBacktick", true),
        debounce_ms: config.get("debounceMs", 60),
        extra_events: config.get("extraEvents", []),
      };
      await execute(`
        local owner = ${literal(this.token)}
        local ok, err = pcall(function()
          local marks = package.loaded["nvim-marks"]
          if marks and not marks._owner then
            error("Remove the separate nvim-marks plugin from your Neovim configuration and reload VS Code; Lua is now bundled with the extension.")
          end
          if not marks or marks._owner ~= owner then
            if marks then marks.teardown() end
            marks = assert(loadstring(${literal(this.source)}, "@nvim-marks/bundled/init.lua"))()
            marks._owner = owner
            package.loaded["nvim-marks"] = marks
          end
          marks.setup(vim.json.decode(${literal(JSON.stringify(options))}))
        end)
        require("vscode").action("nvimMarks.bridgeStatus", { args = { owner, not ok and tostring(err) or false } })
      `);
    }).catch((error) => this.failed(error));
    return this.pending;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.stopTask = this.pending.then(async () => {
      try {
        await execute(`
          local marks = package.loaded["nvim-marks"]
          if marks and marks._owner == ${literal(this.token)} then
            marks.teardown()
            package.loaded["nvim-marks"] = nil
          end
        `);
      } catch {
        // The dependency may already have stopped during VS Code shutdown.
      }
    });
    return this.stopTask;
  }

  dispose(): void {
    void this.stop();
  }
}
