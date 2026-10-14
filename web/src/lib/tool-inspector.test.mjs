import {
  buildBoundedDiff,
  fileContentLines,
  hasCompleteSnapshots,
  inspectorModel,
  readRecordLines,
  toolInputObject,
  toolInspectorKind,
} from "./tool-inspector.ts";
import assert from "node:assert/strict";
import test from "node:test";

const row = (seq, extra = {}) => ({ seq, worker: "mainagent", kind: "tool_result", ts: "", summary: "", ...extra });
const group = (name, input, output, artifact) => ({
  type: "tool",
  key: 1,
  worker: "mainagent",
  use: row(1, { kind: "tool_use", tool: name, detail: JSON.stringify(input) }),
  result: row(2, { tool: name, detail: output, metadata: artifact ? { tool_artifact: artifact } : undefined }),
});

test("inspector recognizes only exact tool aliases", () => {
  assert.equal(toolInspectorKind("Read"), "read");
  assert.equal(toolInspectorKind("MultiEdit"), "change");
  assert.equal(toolInspectorKind("WebSearch"), "raw");
  assert.equal(toolInspectorKind("mcp__read_database"), "raw");
});

test("clipped input is not mistaken for a complete file target", () => {
  assert.deepEqual(toolInputObject({ use: row(1, { tool: "Read", summary: 'Read {"file_path":"src/partial' }) }), {});
  assert.equal(
    toolInputObject({ use: row(1, { tool: "Read", summary: 'Read {"file_path":"src/a.ts"}' }) }).file_path,
    "src/a.ts",
  );
});

test("only structured artifact entries become file navigation", () => {
  const artifact = { version: 1, kind: "search", path: "src", entries: [{ path: "a:b.ts", line: 8, text: "result" }] };
  const value = inspectorModel(group("Grep", { pattern: "result", path: "src" }, "arbitrary:9:output", artifact));
  assert.deepEqual(value.entries, artifact.entries);
  assert.equal(value.legacy, false);
  assert.deepEqual(inspectorModel(group("Grep", {}, "src/a.ts:7:hello")).entries, []);
  assert.deepEqual(inspectorModel(group("Glob", {}, "src/a.ts\nsrc/b.ts")).entries, []);
});

test("future artifact versions remain conservative", () => {
  const value = inspectorModel(
    group("Read", { file_path: "recorded.txt" }, "text", { version: 2, kind: "change", path: "other.txt" }),
  );
  assert.equal(value.kind, "read");
  assert.equal(value.path, "recorded.txt");
  assert.equal(value.legacy, true);
});

test("read records preserve actual offset line numbers and explicit truncation", () => {
  const result = readRecordLines(
    "    42\tfirst\n    43\tsecond… [line truncated]\n\n... [Read truncated to fit the output limit.] ...",
  );
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.lines.slice(0, 2).map((line) => line.number),
    [42, 43],
  );
  assert.equal(result.lines[3].number, undefined);
  assert.match(result.lines[3].text, /truncated/);
});

test("unproven line numbers and nonsequential text remain raw", () => {
  assert.deepEqual(readRecordLines("error in file").lines, [{ text: "error in file", number: undefined }]);
  const raw = "1\tfirst\n900\tnot a read record";
  assert.equal(readRecordLines(raw).lines[0].text, "1\tfirst");
  assert.equal(readRecordLines(raw).lines[0].number, undefined);
});

test("actual file content is never stripped as a tool line prefix", () => {
  assert.deepEqual(fileContentLines("42\tvalue\n"), [{ number: 1, text: "42\tvalue" }]);
  assert.deepEqual(fileContentLines(""), []);
});

test("diff computes exact insertions, deletions and line numbers", () => {
  const value = buildBoundedDiff("first\nold\nlast\n", "first\nnew\nadded\nlast\n");
  assert.equal(value.exact, true);
  assert.equal(value.added, 2);
  assert.equal(value.removed, 1);
  assert.deepEqual(
    value.lines.filter((line) => line.kind === "add").map((line) => line.afterLine),
    [2, 3],
  );
  assert.deepEqual(
    value.lines.filter((line) => line.kind === "remove").map((line) => line.beforeLine),
    [2],
  );
  assert.equal(value.lines.at(-1).beforeLine, 3);
  assert.equal(value.lines.at(-1).afterLine, 4);
});

test("empty-file creation and exact unchanged snapshots have honest statistics", () => {
  assert.deepEqual(
    { added: buildBoundedDiff("", "a\nb\n").added, removed: buildBoundedDiff("", "a\nb\n").removed },
    { added: 2, removed: 0 },
  );
  const same = buildBoundedDiff("same\n", "same\n");
  assert.equal(same.added, 0);
  assert.equal(same.removed, 0);
  assert.equal(buildBoundedDiff("", "").lines.length, 0);
});

test("final newline changes remain visible", () => {
  const value = buildBoundedDiff("line", "line\n");
  assert.equal(value.added, 1);
  assert.equal(value.removed, 1);
  assert.equal(value.lines.find((line) => line.kind === "remove").noNewline, true);
});

test("bounded algorithm declines pathological input without inventing counts", () => {
  const value = buildBoundedDiff(
    Array.from({ length: 1500 }, (_, i) => `old-${i}\n`).join(""),
    Array.from({ length: 1500 }, (_, i) => `new-${i}\n`).join(""),
  );
  assert.equal(value.exact, false);
  assert.equal(value.added, null);
  assert.equal(value.removed, null);
  assert.equal(buildBoundedDiff("x".repeat(2_000_001), "y").exact, false);
});

test("large common prefix and suffix do not consume an unbounded edit matrix", () => {
  const prefix = "unchanged\n".repeat(8000);
  const value = buildBoundedDiff(`${prefix}old\nlast\n`, `${prefix}new\nlast\n`);
  assert.equal(value.exact, true);
  assert.equal(value.added, 1);
  assert.equal(value.removed, 1);
});

test("replaying every exact diff reconstructs both original snapshots", () => {
  let seed = 41;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % 6;
  };
  for (let attempt = 0; attempt < 150; attempt++) {
    const a = Array.from({ length: rand() + 1 }, () => `${rand()}\n`).join("");
    const b = Array.from({ length: rand() + 1 }, () => `${rand()}\n`).join("");
    const diff = buildBoundedDiff(a, b);
    assert.equal(diff.exact, true);
    const replay = (omit) =>
      diff.lines
        .filter((row) => row.kind !== omit)
        .map((row) => row.text + (row.noNewline ? "" : "\n"))
        .join("");
    assert.equal(replay("add"), a);
    assert.equal(replay("remove"), b);
  }
});

test("only complete successful snapshot metadata authorizes a real diff", () => {
  const complete = { version: 1, kind: "change", path: "a", snapshot_available: true, before: "", after: "new" };
  assert.equal(hasCompleteSnapshots(complete), true);
  assert.equal(hasCompleteSnapshots({ ...complete, truncated: true }), false);
  assert.equal(hasCompleteSnapshots({ ...complete, before: undefined }), false);
  assert.equal(hasCompleteSnapshots({ ...complete, snapshot_available: false }), false);
});
