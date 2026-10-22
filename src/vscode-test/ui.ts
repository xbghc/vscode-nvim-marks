/** Renderer-level keys and focus assertions for the isolated VS Code test window. */
import * as fs from "node:fs";
import * as path from "node:path";

export async function connectUI(testRoot: string) {
  const port = fs.readFileSync(path.join(testRoot, "user-data", "DevToolsActivePort"), "utf8").split(/\r?\n/)[0];
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((entry) => entry.type === "page");
  if (!target) throw new Error("No VS Code renderer available for keyboard tests.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Cannot connect to the test renderer.")), { once: true });
  });
  let id = 0;
  const request = (method: string, params: object): Promise<any> => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error(`Renderer request timed out: ${method}`));
    }, 5000);
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== requestId) return;
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  return {
    async evaluate<T>(expression: string): Promise<T> {
      const result = await request("Runtime.evaluate", { expression, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value as T;
    },
    async press(key: string): Promise<void> {
      const windowsVirtualKeyCode = key === "Escape" ? 27 : key === "`" ? 192 : key.toUpperCase().charCodeAt(0);
      const code = key === "Escape" ? "Escape" : key === "`" ? "Backquote" : `Key${key.toUpperCase()}`;
      await request("Input.dispatchKeyEvent", {
        type: "keyDown", key, code, windowsVirtualKeyCode, text: key.length === 1 ? key : "",
      });
      await request("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
    },
    close: () => socket.close(),
  };
}
