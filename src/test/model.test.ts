import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStore,
  checkCompat,
  compareVersions,
  decorationKey,
  groupByLine,
  makeNormalizer,
  MIN_PLUGIN_VERSION,
  payloadInfo,
  PROTOCOL_VERSION,
} from "../model";
import { markIconSvg, markIconUri } from "../icons";

const norm = makeNormalizer("linux");

test("normalizer folds slashes, trailing slash, and case on win32", () => {
  const win = makeNormalizer("win32");
  assert.equal(win("C:\\Users\\Me\\a.ts"), "c:/users/me/a.ts");
  assert.equal(win("C:/x/"), "c:/x");
  assert.equal(norm("/home/u/a.ts"), "/home/u/a.ts");
  assert.equal(norm("/Home/U/a.ts"), "/Home/U/a.ts");
  assert.equal(norm("/"), "/");
});

test("buildStore converts 1-based wire positions to 0-based and groups by file", () => {
  const store = buildStore(
    {
      version: 1,
      locals: [
        { file: "/p/a.ts", marks: [{ name: "b", line: 10, col: 3 }, { name: "a", line: 2, col: 1 }] },
        { file: "/p/b.ts", marks: [{ name: "a", line: 1, col: 1 }] },
      ],
      globals: [{ name: "A", file: "/p/a.ts", line: 10, col: 5 }],
    },
    norm,
  );
  assert.deepEqual([...store.byFile.keys()].sort(), ["/p/a.ts", "/p/b.ts"]);
  const a = store.byFile.get("/p/a.ts")!;
  assert.deepEqual(
    a.map((m) => [m.name, m.kind, m.line, m.col]),
    [
      ["a", "local", 1, 0],
      ["b", "local", 9, 2],
      ["A", "global", 9, 4],
    ],
  );
});

test("buildStore drops malformed entries instead of throwing", () => {
  const store = buildStore(
    {
      locals: [
        { file: "", marks: [{ name: "a", line: 1, col: 1 }] },
        { file: "/p/x", marks: [{ name: "'", line: 1, col: 1 }, { name: "a", line: 0, col: 1 }, { name: "z", line: "3" }] },
        null,
        "junk",
      ],
      globals: [{ name: "a", file: "/p/x", line: 1, col: 1 }, { name: "Z", line: 1, col: 1 }, { name: "Y", file: "/p/y", line: 4 }],
    },
    norm,
  );
  assert.equal(store.byFile.has("/p/x"), false);
  assert.deepEqual(store.byFile.get("/p/y")!.map((m) => [m.name, m.line, m.col]), [["Y", 3, 0]]);
  assert.deepEqual(buildStore(undefined, norm).byFile.size, 0);
  assert.deepEqual(buildStore(42, norm).byFile.size, 0);
});

test("groupByLine combines marks on one line and collapses long labels", () => {
  const store = buildStore(
    {
      locals: [{ file: "/f", marks: [{ name: "c", line: 5, col: 1 }, { name: "a", line: 5, col: 1 }, { name: "b", line: 5, col: 1 }, { name: "d", line: 1, col: 1 }] }],
      globals: [{ name: "Q", file: "/f", line: 7, col: 1 }, { name: "R", file: "/f", line: 1, col: 1 }],
    },
    norm,
  );
  const lines = groupByLine(store.byFile.get("/f")!, { showLocal: true, showGlobal: true });
  assert.deepEqual(
    lines.map((l) => [l.line, l.label, l.kind]),
    [
      [0, "dR", "global"],
      [4, "a+", "local"],
      [6, "Q", "global"],
    ],
  );
  assert.deepEqual(groupByLine(store.byFile.get("/f")!, { showLocal: true, showGlobal: true, maxLetters: 3 })[1].label, "abc");
});

test("groupByLine respects visibility switches", () => {
  const store = buildStore(
    { locals: [{ file: "/f", marks: [{ name: "a", line: 1, col: 1 }] }], globals: [{ name: "A", file: "/f", line: 2, col: 1 }] },
    norm,
  );
  const marks = store.byFile.get("/f")!;
  assert.deepEqual(groupByLine(marks, { showLocal: false, showGlobal: true }).map((l) => l.label), ["A"]);
  assert.deepEqual(groupByLine(marks, { showLocal: true, showGlobal: false }).map((l) => l.label), ["a"]);
  assert.deepEqual(groupByLine(marks, { showLocal: false, showGlobal: false }), []);
});

test("decorationKey is stable and parsable", () => {
  assert.equal(decorationKey("local", "ab"), "local:ab");
  assert.equal(decorationKey("global", "A+"), "global:A+");
});

test("icon svg escapes text, frames globals, and encodes as data uri", () => {
  const local = markIconSvg("a", "local", "#123456");
  assert.match(local, /<text [^>]*>a<\/text>/);
  assert.doesNotMatch(local, /<rect/);
  const global = markIconSvg("A", "global", "#abcdef");
  assert.match(global, /<rect/);
  assert.match(markIconSvg("<", "local", "#000"), /&lt;/);
  const uri = markIconUri("ab", "local", "#000");
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  const decoded = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
  assert.equal(decoded, markIconSvg("ab", "local", "#000"));
});

test("compareVersions orders major.minor.patch numerically and ignores suffixes", () => {
  assert.equal(compareVersions("0.1.3", "0.1.3"), 0);
  assert.ok(compareVersions("0.1.10", "0.1.9")! > 0);
  assert.ok(compareVersions("0.2.0", "1.0.0")! < 0);
  assert.equal(compareVersions("0.1.3-alpha.1", "0.1.3"), 0);
  assert.equal(compareVersions("dev", "0.1.3"), undefined);
});

test("payloadInfo reads protocol and plugin version, tolerating junk", () => {
  assert.deepEqual(payloadInfo({ version: 1, plugin_version: "0.1.3", locals: [], globals: [] }), { protocol: 1, pluginVersion: "0.1.3" });
  assert.deepEqual(payloadInfo({ version: "1", plugin_version: 3 }), {});
  assert.equal(payloadInfo("garbage"), undefined);
  assert.equal(payloadInfo(undefined), undefined);
});

test("checkCompat names the half that has to be updated", () => {
  assert.equal(checkCompat({ protocol: PROTOCOL_VERSION, pluginVersion: MIN_PLUGIN_VERSION }), undefined);
  assert.equal(checkCompat({ protocol: PROTOCOL_VERSION, pluginVersion: "9.0.0" }), undefined);
  // Plugins before 0.1.3 do not report their version.
  assert.equal(checkCompat({ protocol: PROTOCOL_VERSION })?.outdated, "plugin");
  assert.equal(checkCompat({ protocol: PROTOCOL_VERSION, pluginVersion: "0.1.2" })?.outdated, "plugin");
  assert.equal(checkCompat({ protocol: PROTOCOL_VERSION - 1, pluginVersion: "9.0.0" })?.outdated, "plugin");
  assert.equal(checkCompat({ protocol: PROTOCOL_VERSION + 1, pluginVersion: "9.0.0" })?.outdated, "extension");
});

test("checkCompat warns about plugins without the backtick picker mapping", () => {
  const issue = checkCompat({ protocol: PROTOCOL_VERSION, pluginVersion: "0.1.3" });
  assert.equal(issue?.outdated, "plugin");
  assert.match(issue!.message, /0\.1\.4 or newer/);
  assert.match(issue!.message, /Update the Neovim Marks extension/);
  assert.match(issue!.message, /remove any separate nvim-marks installation/);
  assert.match(issue!.message, /reload VS Code/);
  assert.equal(checkCompat({ protocol: PROTOCOL_VERSION, pluginVersion: "0.1.4" }), undefined);
});
