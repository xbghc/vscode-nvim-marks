// Renderer tests inject snapshots directly. The real bridge is covered by test:neovim.
const vscode = require("vscode");
exports.activate = (context) => {
  context.subscriptions.push(vscode.commands.registerCommand("vscode-neovim.lua", () => {}));
};
