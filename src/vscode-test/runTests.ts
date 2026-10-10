/**
 * Launches a real VS Code instance with the extension loaded and runs
 * ./suite.ts inside it. Requires network access to download VS Code once;
 * on Linux without a display run under `xvfb-run -a`.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nvim-marks-ws-"));
  fs.writeFileSync(path.join(workspace, "a.txt"), ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"));
  fs.writeFileSync(path.join(workspace, "b.txt"), ["b 1", "b 2", "b 3"].join("\n"));

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, "--disable-extensions", "--disable-gpu", "--no-sandbox"],
      extensionTestsEnv: { NVIM_MARKS_TEST_WORKSPACE: workspace },
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("integration tests failed:", err);
  process.exit(1);
});
