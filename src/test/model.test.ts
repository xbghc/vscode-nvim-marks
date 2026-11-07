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

test("icon svg renders borderless letters, escapes text, and encodes as data uri", () => {
  const local = markIconSvg("a", "#123456");
  assert.match(local, /<text [^>]*>a<\/text>/);
  assert.doesNotMatch(local, /<rect/);
  const global = markIconSvg("A", "#abcdef");
  assert.match(global, /<text [^>]*>A<\/text>/);
  assert.doesNotMatch(global, /<rect/);
  assert.match(markIconSvg("<", "#000"), /&lt;/);
  const uri = markIconUri("ab", "#000");
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  const decoded = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
  assert.equal(decoded, markIconSvg("ab", "#000"));
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

test("normalizer handles drive roots, multiple trailing slashes, UNC paths, and empty string", () => {
  const win = makeNormalizer("win32");
  assert.equal(win("C:\\"), "c:/");
  assert.equal(win("C:/"), "c:/");
  assert.equal(win("D:///"), "d:/");
  assert.equal(win("\\\\Server\\Share\\File.ts\\"), "//server/share/file.ts");
  assert.equal(win(""), "");
  assert.equal(norm("/a/b///"), "/a/b");
  assert.equal(norm("///"), "/");
  assert.equal(norm("\\\\server\\share\\file.ts"), "//server/share/file.ts");
  assert.equal(norm(""), "");
});

test("buildStore handles floats, non-finite numbers, negative/zero col, deduplication, and same-line sorting", () => {
  const win = makeNormalizer("win32");
  const store = buildStore(
    {
      locals: [
        {
          file: "/p/edge.ts",
          marks: [
            { name: "a", line: 1.5, col: 1 },
            { name: "b", line: Number.NaN, col: 1 },
            { name: "c", line: Number.POSITIVE_INFINITY, col: 1 },
            { name: "d", line: Number.NEGATIVE_INFINITY, col: 1 },
            { name: "e", line: 2, col: 2.5 },
            { name: "f", line: 3, col: 0 },
            { name: "g", line: 4, col: -2 },
          ],
        },
        {
          file: "/p/same.ts",
          marks: [
            { name: "b", line: 1, col: 5 },
            { name: "a", line: 1, col: 2 },
            { name: "a", line: 1, col: 9 },
          ],
        },
      ],
      globals: [
        { name: "B", file: "/p/same.ts", line: 1, col: 3 },
        { name: "A", file: "/p/other.ts", line: 7, col: 1 },
        { name: "A", file: "/p/same.ts", line: 1, col: 4 },
      ],
    },
    norm,
  );

  assert.deepEqual(
    store.byFile.get("/p/edge.ts")!.map((m) => [m.name, m.line, m.col]),
    [
      ["e", 1, 0],
      ["f", 2, 0],
      ["g", 3, 0],
    ],
  );
  assert.equal(store.byFile.has("/p/other.ts"), false);
  assert.deepEqual(
    store.byFile.get("/p/same.ts")!.map((m) => [m.name, m.kind, m.line, m.col]),
    [
      ["a", "local", 0, 8],
      ["b", "local", 0, 4],
      ["A", "global", 0, 3],
      ["B", "global", 0, 2],
    ],
  );

  const winStore = buildStore(
    {
      locals: [
        { file: "C:\\a.ts", marks: [{ name: "a", line: 1, col: 1 }] },
        { file: "c:/a.ts", marks: [{ name: "a", line: 5, col: 3 }] },
      ],
      globals: [],
    },
    win,
  );
  assert.deepEqual(
    winStore.byFile.get("c:/a.ts")!.map((m) => [m.name, m.line, m.col]),
    [["a", 4, 2]],
  );
});

test("groupByLine handles empty input, mixed local/global lines, and small maxLetters", () => {
  assert.deepEqual(groupByLine([], { showLocal: true, showGlobal: true }), []);

  const pairMarks = buildStore(
    {
      locals: [{ file: "/f", marks: [{ name: "a", line: 1, col: 1 }] }],
      globals: [{ name: "A", file: "/f", line: 1, col: 2 }],
    },
    norm,
  ).byFile.get("/f")!;
  assert.deepEqual(
    groupByLine(pairMarks, { showLocal: true, showGlobal: false }).map((l) => [l.label, l.kind]),
    [["a", "local"]],
  );
  assert.deepEqual(
    groupByLine(pairMarks, { showLocal: false, showGlobal: true }).map((l) => [l.label, l.kind]),
    [["A", "global"]],
  );

  const store = buildStore(
    {
      locals: [{ file: "/f", marks: [{ name: "a", line: 1, col: 1 }, { name: "b", line: 1, col: 2 }] }],
      globals: [{ name: "A", file: "/f", line: 1, col: 3 }],
    },
    norm,
  );
  const marks = store.byFile.get("/f")!;

  assert.deepEqual(
    groupByLine(marks, { showLocal: true, showGlobal: true }).map((l) => [l.label, l.kind]),
    [["a+", "global"]],
  );
  assert.deepEqual(
    groupByLine(marks, { showLocal: true, showGlobal: false, maxLetters: 1 }).map((l) => l.label),
    ["a+"],
  );
  assert.deepEqual(
    groupByLine(marks, { showLocal: true, showGlobal: false, maxLetters: 0 }).map((l) => l.label),
    ["a+"],
  );
});

test("compareVersions, payloadInfo, and checkCompat handle malformed versions and missing protocol", () => {
  assert.equal(compareVersions("0.1.3", "dev"), undefined);
  assert.equal(compareVersions("0.1.3+2026", "0.1.3"), 0);
  assert.equal(compareVersions("0.1.3.4", "0.1.3"), undefined);
  assert.equal(compareVersions("0.1.3abc", "0.1.3"), undefined);

  assert.deepEqual(payloadInfo({ version: 1.5, plugin_version: "" }), {});
  assert.deepEqual(payloadInfo({ version: Number.NaN, plugin_version: "0.1.4" }), { pluginVersion: "0.1.4" });

  const missingProto = checkCompat({ pluginVersion: "0.1.9" });
  assert.equal(missingProto?.outdated, "plugin");
  assert.match(missingProto!.message, /did not report a valid protocol version/);

  const badVer = checkCompat({ protocol: PROTOCOL_VERSION, pluginVersion: "dev" });
  assert.equal(badVer?.outdated, "plugin");
  assert.match(badVer!.message, /is dev/);
});

test("markIconSvg scales font size by label length and escapes color attributes", () => {
  assert.match(markIconSvg("a", "#000"), /font-size="11"/);
  assert.match(markIconSvg("ab", "#000"), /font-size="8\.5"/);
  assert.match(markIconSvg("a+", "#000"), /font-size="8\.5"/);
  assert.match(markIconSvg("ab+", "#000"), /font-size="7"/);
  const escaped = markIconSvg("a&b", `red" onclick="alert('<x>')`);
  assert.match(escaped, /fill="red&quot; onclick=&quot;alert\(&apos;&lt;x&gt;&apos;\)"/);
  assert.match(escaped, />a&amp;b<\/text>/);
});
