import type { ToolGroup } from "./transcript-groups";
import type { ToolArtifact } from "./types";

export type InspectorKind = "read" | "change" | "search" | "directory" | "raw";
export type InspectorEntry = { path: string; line?: number; text?: string; count?: number };
export type InspectorModel = {
  kind: InspectorKind;
  name: string;
  path: string;
  output: string;
  input: Record<string, unknown>;
  artifact?: ToolArtifact;
  entries: InspectorEntry[];
  legacy: boolean;
};

export function toolInspectorKind(name: string): InspectorKind {
  if (/^(read|readfile|read_file)$/i.test(name)) return "read";
  if (/^(write|edit|multiedit)$/i.test(name)) return "change";
  if (/^(grep|ripgrep|glob)$/i.test(name)) return "search";
  if (/^(ls|list_directory)$/i.test(name)) return "directory";
  return "raw";
}

export function toolInputObject(group: ToolGroup): Record<string, unknown> {
  const name = group.use?.tool ?? "";
  for (const value of [group.use?.detail, group.use?.summary]) {
    if (!value) continue;
    const raw = value.startsWith(name) ? value.slice(name.length).trim() : value;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // A clipped summary is not a complete input record.
    }
  }
  return {};
}

function field(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === "string" ? input[key] : "";
}

export function inspectorModel(group: ToolGroup): InspectorModel {
  const name = group.use?.tool ?? group.result?.tool ?? "工具";
  const input = toolInputObject(group);
  const artifact = group.result?.metadata?.tool_artifact ?? group.use?.metadata?.tool_artifact;
  const validArtifact = artifact?.version === 1 ? artifact : undefined;
  const kind = validArtifact?.kind ?? toolInspectorKind(name);
  const output = group.result?.detail ?? group.result?.summary ?? "";
  const path = validArtifact?.path || field(input, "file_path") || field(input, "path");
  return {
    name,
    kind,
    path,
    input,
    output,
    artifact: validArtifact,
    entries: validArtifact?.entries ?? [],
    legacy: !validArtifact,
  };
}

export type ReadLine = { number?: number; text: string };
export function fileContentLines(content: string): ReadLine[] {
  if (!content) return [];
  const rows = content.split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows.map((text, index) => ({ number: index + 1, text }));
}
export function readRecordLines(output: string, lineStart?: number): { lines: ReadLine[]; truncated: boolean } {
  const rows = output.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const truncated = /\[line truncated\]|\[Read truncated|\[.*output.*truncat/i.test(output);
  const numbered = rows.map((row) => row.match(/^\s*([1-9]\d*)\t(.*)$/));
  let last = 0;
  const hasNumbers = numbered.some(Boolean);
  const validNumbers =
    hasNumbers &&
    numbered.every((match, index) => {
      if (!match) return rows[index] === "" || /^\.\.\. \[Read truncated/.test(rows[index]);
      const value = Number(match[1]);
      const valid = last === 0 || value === last + 1;
      last = value;
      return valid;
    });
  if (validNumbers)
    return {
      lines: rows.map((text, index) =>
        numbered[index] ? { number: Number(numbered[index]?.[1]), text: numbered[index]?.[2] ?? "" } : { text },
      ),
      truncated,
    };
  // Real line_start metadata is sufficient for unprefixed read payloads. Old
  // arbitrary output has no file line numbers and is intentionally unnumbered.
  const start = Number.isSafeInteger(lineStart) && (lineStart ?? 0) > 0 ? lineStart : undefined;
  return {
    lines: rows.map((text, index) => ({ text, number: start === undefined ? undefined : start + index })),
    truncated,
  };
}

export type DiffLine = {
  kind: "context" | "add" | "remove";
  text: string;
  beforeLine?: number;
  afterLine?: number;
  noNewline?: boolean;
};
export type BoundedDiff = {
  exact: boolean;
  lines: DiffLine[];
  added: number | null;
  removed: number | null;
  reason?: string;
};

function diffTokens(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// Myers uses a bounded edit frontier, not an n*m matrix. In pathological input
// we expose the two snapshots without claiming exact changed-line statistics.
export function buildBoundedDiff(before: string, after: string): BoundedDiff {
  if (before.length + after.length > 2_000_000)
    return { exact: false, lines: [], added: null, removed: null, reason: "文件内容较大，改为分别查看修改前后内容。" };
  const a = diffTokens(before);
  const b = diffTokens(after);
  if (a.length + b.length > 20_000)
    return { exact: false, lines: [], added: null, removed: null, reason: "文件行数较多，改为分别查看修改前后内容。" };
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const xRows = a.slice(prefix, a.length - suffix);
  const yRows = b.slice(prefix, b.length - suffix);
  type Op = { kind: DiffLine["kind"]; text: string };
  const operations: Op[] = a.slice(0, prefix).map((text) => ({ kind: "context", text }));
  if (!xRows.length) operations.push(...yRows.map((text): Op => ({ kind: "add", text })));
  else if (!yRows.length) operations.push(...xRows.map((text): Op => ({ kind: "remove", text })));
  else {
    let frontier = new Map<number, number>([[1, 0]]);
    const trace: Map<number, number>[] = [];
    let distance = -1;
    let work = 0;
    outer: for (let d = 0; d <= Math.min(xRows.length + yRows.length, 256); d++) {
      trace.push(new Map(frontier));
      const next = new Map<number, number>();
      for (let k = -d; k <= d; k += 2) {
        if (++work > 200_000) break outer;
        let x =
          k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))
            ? (frontier.get(k + 1) ?? 0)
            : (frontier.get(k - 1) ?? 0) + 1;
        let y = x - k;
        while (x < xRows.length && y < yRows.length && xRows[x] === yRows[y]) {
          x++;
          y++;
          if (++work > 200_000) break outer;
        }
        next.set(k, x);
        if (x >= xRows.length && y >= yRows.length) {
          distance = d;
          break outer;
        }
      }
      frontier = next;
    }
    if (distance < 0)
      return {
        exact: false,
        lines: [],
        added: null,
        removed: null,
        reason: "差异较大，改为分别查看修改前后内容；未计算精确增删行数。",
      };
    let x = xRows.length;
    let y = yRows.length;
    const middle: Op[] = [];
    for (let d = distance; d >= 0; d--) {
      const v = trace[d];
      const k = x - y;
      const previousK = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? k + 1 : k - 1;
      const previousX = v.get(previousK) ?? 0;
      const previousY = previousX - previousK;
      while (x > previousX && y > previousY) {
        middle.push({ kind: "context", text: xRows[x - 1] });
        x--;
        y--;
      }
      if (d === 0) break;
      if (x === previousX) {
        middle.push({ kind: "add", text: yRows[y - 1] });
        y--;
      } else {
        middle.push({ kind: "remove", text: xRows[x - 1] });
        x--;
      }
    }
    operations.push(...middle.reverse());
  }
  if (suffix) operations.push(...a.slice(a.length - suffix).map((text): Op => ({ kind: "context", text })));
  let oldLine = 1;
  let newLine = 1;
  const lines = operations.map(
    ({ kind, text }): DiffLine => ({
      kind,
      text: text.replace(/\n$/, ""),
      beforeLine: kind === "add" ? undefined : oldLine++,
      afterLine: kind === "remove" ? undefined : newLine++,
      noNewline: !text.endsWith("\n"),
    }),
  );
  return {
    exact: true,
    lines,
    added: lines.filter((row) => row.kind === "add").length,
    removed: lines.filter((row) => row.kind === "remove").length,
  };
}

export function hasCompleteSnapshots(artifact?: ToolArtifact): boolean {
  return (
    artifact?.kind === "change" &&
    artifact.snapshot_available === true &&
    !artifact.truncated &&
    typeof artifact.before === "string" &&
    typeof artifact.after === "string"
  );
}
