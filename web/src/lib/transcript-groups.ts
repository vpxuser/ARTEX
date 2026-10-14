import type { Activity } from "./types";

export type ToolGroup = {
  type: "tool";
  key: number;
  worker: string;
  use?: Activity;
  result?: Activity;
};

export type TranscriptStep =
  | ToolGroup
  | { type: "thinking" | "progress" | "answer"; key: number; worker: string; steps: Activity[] }
  | { type: "intercept"; key: number; step: Activity };

export type ToolSequence = { type: "tool-sequence"; key: number; tools: ToolGroup[] };
export type DisplayStep = Exclude<TranscriptStep, ToolGroup> | ToolSequence;

// A sequence keeps the same identity as results arrive. Presentation can fold
// successful spans without regrouping across prose, thinking or approval cards.
export function groupToolSequences(steps: TranscriptStep[]): DisplayStep[] {
  const output: DisplayStep[] = [];
  for (const step of steps) {
    const previous = output[output.length - 1];
    if (step.type !== "tool") output.push(step);
    else if (previous?.type === "tool-sequence") previous.tools.push(step);
    else output.push({ type: "tool-sequence", key: step.key, tools: [step] });
  }
  return output;
}

export function completedToolRuns(tools: ToolGroup[], live: boolean, complete: boolean): ToolGroup[][] {
  const runs: ToolGroup[][] = [];
  for (const tool of tools) {
    const previous = runs[runs.length - 1];
    if (
      toolStatus(tool, live, complete) === "success" &&
      previous?.every((item) => toolStatus(item, live, complete) === "success")
    ) {
      previous.push(tool);
    } else runs.push([tool]);
  }
  return runs;
}

export type AssistantTurn = {
  type: "assistant";
  key: number;
  worker: string;
  steps: TranscriptStep[];
  complete: boolean;
};

export type AssistantTurnPresentation = {
  process: TranscriptStep[];
  response: TranscriptStep[];
  toolCount: number;
  errorCount: number;
  hasAttention: boolean;
  duration: string | null;
};

function stepActivities(step: TranscriptStep): Activity[] {
  if (step.type === "tool") return [step.use, step.result].filter((row): row is Activity => row !== undefined);
  if (step.type === "intercept") return [step.step];
  return step.steps;
}

// Split only a trailing response suffix, so an approval or a later operation
// never moves ahead of prose that preceded it. Plain chat has no explicit
// result event: its final text becomes an answer only after the turn ends.
export function assistantTurnPresentation(entry: AssistantTurn, live: boolean): AssistantTurnPresentation {
  let responseStart = entry.steps.length;
  while (responseStart > 0 && entry.steps[responseStart - 1].type === "answer") responseStart--;
  let process = entry.steps.slice(0, responseStart);
  let response = entry.steps.slice(responseStart);
  const last = entry.steps[entry.steps.length - 1];
  if (response.length === 0 && (entry.complete || !live) && last?.type === "progress") {
    // System notices share a progress block with adjacent prose. Leave the
    // notice in place while exposing only the trailing plain-text response.
    let textStart = last.steps.length;
    while (textStart > 0 && last.steps[textStart - 1].kind === "text" && !last.steps[textStart - 1].is_error)
      textStart--;
    if (textStart < last.steps.length) {
      process = entry.steps.slice(0, -1);
      if (textStart > 0) {
        process.push({ ...last, key: last.steps[0].seq, steps: last.steps.slice(0, textStart) });
      }
      const text = last.steps.slice(textStart);
      response = [{ ...last, type: "answer", key: text[0].seq, steps: text }];
    }
  }

  const rows = entry.steps.flatMap(stepActivities);
  const errorCount = rows.filter((row) => row.is_error).length;
  // Results are paired at their call's position, including parallel calls that
  // finish out of order. Recorded sequence IDs restore event chronology only
  // for elapsed time; presentation order and the original arrays stay intact.
  const times = [...rows].sort((a, b) => a.seq - b.seq).map((row) => Date.parse(row.ts));
  const timed =
    times.length >= 2 && times.every((time, index) => Number.isFinite(time) && (!index || time >= times[index - 1]));

  return {
    process,
    response,
    toolCount: entry.steps.filter((step) => step.type === "tool").length,
    errorCount,
    hasAttention:
      errorCount > 0 ||
      entry.steps.some(
        (step) =>
          step.type === "intercept" || (step.type === "tool" && toolStatus(step, live, entry.complete) === "missing"),
      ),
    duration: timed ? formatElapsed(times[times.length - 1] - times[0]) : null,
  };
}

export type TranscriptEntry =
  | { type: "user"; key: number; step: Activity; intent: boolean }
  | { type: "round"; key: number; label: string }
  | AssistantTurn;

function ownerKey(step: Activity): string {
  return JSON.stringify([step.source_task_id ?? "", step.worker, step.intent_id ?? "", step.main_seg ?? 0]);
}

// Keep visible progress in order, but pair tool results by identity: parallel
// calls can finish out of order, and inherited sessions can reuse tool IDs.
export function groupTranscript(activities: Activity[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, ToolGroup>();
  const pendingTurns = new Map<string, { activity: Activity; turns: AssistantTurn[] }>();
  let current: AssistantTurn | undefined;
  let currentOwner = "";

  const finishOwner = (owner: string) => {
    for (const turn of pendingTurns.get(owner)?.turns ?? []) turn.complete = true;
    pendingTurns.delete(owner);
  };

  for (const activity of activities) {
    if (activity.kind === "usage") continue;
    const owner = ownerKey(activity);
    if (activity.kind === "user" || activity.kind === "intent" || activity.kind === "round") {
      finishOwner(owner);
      // Some conversation sources label a human row "user", whereas persisted
      // task rows use the target agent's worker key. Close the interactive lane
      // in that session, without ending concurrent intent/planner executions.
      if (activity.kind === "user" && ["", "user", "human"].includes(activity.worker)) {
        for (const [key, pending] of pendingTurns) {
          const candidate = pending.activity;
          if (
            !candidate.intent_id &&
            !["planner", "system"].includes(candidate.worker) &&
            !/^work#/.test(candidate.worker) &&
            (candidate.source_task_id ?? "") === (activity.source_task_id ?? "") &&
            (candidate.main_seg ?? 0) === (activity.main_seg ?? 0)
          )
            finishOwner(key);
        }
      }
      current = undefined;
      if (activity.kind === "round") {
        entries.push({ type: "round", key: activity.seq, label: activity.summary || "新一轮" });
      } else {
        entries.push({ type: "user", key: activity.seq, step: activity, intent: activity.kind === "intent" });
      }
      continue;
    }

    const toolKey = activity.tool_use_id ? `${owner}:${activity.tool_use_id}` : "";
    if (activity.kind === "tool_result" && toolKey) {
      const paired = tools.get(toolKey);
      if (paired && !paired.result) {
        paired.result = activity;
        continue;
      }
    }

    if (!current || currentOwner !== owner || current.complete) {
      current = { type: "assistant", key: activity.seq, worker: activity.worker, steps: [], complete: false };
      currentOwner = owner;
      entries.push(current);
      pendingTurns.set(owner, { activity, turns: [...(pendingTurns.get(owner)?.turns ?? []), current] });
    }

    if (activity.kind === "tool_use" || activity.kind === "tool_result") {
      const group: ToolGroup = { type: "tool", key: activity.seq, worker: activity.worker };
      if (activity.kind === "tool_use") {
        group.use = activity;
        if (toolKey) tools.set(toolKey, group);
      } else {
        group.result = activity;
      }
      current.steps.push(group);
    } else if (activity.kind === "intercept_request") {
      current.steps.push({ type: "intercept", key: activity.seq, step: activity });
    } else {
      let type: "thinking" | "answer" | "progress" = "progress";
      if (activity.kind === "thinking") type = "thinking";
      if (activity.kind === "result") type = "answer";
      const previous = current.steps[current.steps.length - 1];
      if (previous && previous.type === type && "steps" in previous) {
        previous.steps.push(activity);
      } else {
        current.steps.push({ type, key: activity.seq, worker: activity.worker, steps: [activity] });
      }
      if (activity.kind === "result" || (activity.kind === "text" && activity.is_error)) {
        finishOwner(owner);
        current = undefined;
      }
    }
  }
  return entries;
}

export function toolStatus(
  group: ToolGroup,
  live: boolean,
  complete = false,
): "running" | "success" | "error" | "missing" {
  if (group.result) return group.result.is_error ? "error" : "success";
  return live && !complete && !group.use?.inherited ? "running" : "missing";
}

// Input summaries can end in the middle of JSON. Extract only fields actually
// present in the payload; never make up a description or command.
function inputField(raw: string, fields: string[]): string {
  try {
    const input = JSON.parse(raw);
    for (const field of fields) if (typeof input?.[field] === "string") return input[field];
  } catch {
    for (const field of fields) {
      const match = raw.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`));
      if (!match) continue;
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        const escaped: Record<string, string> = { n: "\n", r: "\r", t: "\t" };
        return match[1].replace(/\\(["\\/nrt])/g, (_match, char: string) => escaped[char] ?? char);
      }
    }
  }
  return "";
}

const toolTitles: Record<string, string> = {
  Bash: "执行命令",
  Shell: "执行命令",
  Terminal: "执行命令",
  exec_command: "执行命令",
  Read: "读取文件",
  ReadFile: "读取文件",
  read_file: "读取文件",
  Write: "写入文件",
  Edit: "编辑文件",
  MultiEdit: "编辑文件",
  Glob: "查找文件",
  LS: "查看目录",
  list_directory: "查看目录",
  Grep: "搜索内容",
  Ripgrep: "搜索内容",
  Search: "搜索内容",
  WebSearch: "搜索网页",
  web_search: "搜索网页",
  WebFetch: "读取网页",
  web_fetch: "读取网页",
  TodoWrite: "更新计划",
  Task: "委派任务",
  TaskOutput: "读取任务输出",
  TaskStop: "停止任务",
  graph_overview: "查看任务态势",
  get_worker_output: "查看执行结果",
  add_intent: "创建探索任务",
  report_finding: "记录发现",
  list_assets: "查看资产",
};

const terminalTools = new Set(["bash", "shell", "terminal", "exec_command"]);
const searchTools = new Set(["grep", "ripgrep", "search", "glob", "websearch", "web_search"]);
const summaryTools = new Set([
  "read",
  "readfile",
  "read_file",
  "grep",
  "ripgrep",
  "search",
  "glob",
  "ls",
  "list_directory",
  "websearch",
  "web_search",
  "webfetch",
  "web_fetch",
  "graph_overview",
  "list_assets",
]);

// Exact aliases only: an unfamiliar MCP tool may read, mutate or execute even
// when its name includes a familiar word, so keep its full detail by default.
export function toolPresentation(name: string): "terminal" | "summary" | "detail" {
  const normalized = name.toLowerCase();
  if (terminalTools.has(normalized)) return "terminal";
  if (summaryTools.has(normalized)) return "summary";
  return "detail";
}

export function describeTool(group: ToolGroup): { name: string; title: string; preview: string } {
  const name = group.use?.tool || group.result?.tool || "工具";
  const summary = group.use?.summary ?? "";
  const raw = summary.startsWith(name) ? summary.slice(name.length).trimStart() : summary;
  const fields = ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description"];
  const query = searchTools.has(name.toLowerCase()) ? callInputField(group, ["pattern", "query"]) : "";
  const preview = query || callInputField(group, fields) || formatToolData(raw, "compact");
  const canonical = Object.keys(toolTitles).find((title) => title.toLowerCase() === name.toLowerCase());
  return { name, title: canonical ? toolTitles[canonical] : `调用 ${name}`, preview };
}

function callInputField(group: ToolGroup, fields: string[]): string {
  return inputField(group.use?.detail ?? "", fields) || inputField(group.use?.summary ?? "", fields);
}

export function toolInputText(tool: string, raw: string): string {
  return toolPresentation(tool) === "terminal" ? inputField(raw, ["command", "cmd"]) || raw : raw;
}

// Show an object people can identify without pretending to know why a command
// was run. The full command remains available in the terminal disclosure.
export function workspaceRelativePath(path: string, workingDir?: string): string {
  if (!workingDir) return path;
  const root = workingDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = path.replace(/\\/g, "/");
  if (normalized === root) return ".";
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : path;
}

export function toolObject(group: ToolGroup): string {
  const description = describeTool(group);
  const artifact = group.result?.metadata?.tool_artifact;
  if (searchTools.has(description.name.toLowerCase())) {
    const query = callInputField(group, ["pattern", "query"]);
    const scope = workspaceRelativePath(artifact?.path || callInputField(group, ["file_path", "path"]), artifact?.working_dir);
    return query && scope ? `${query} · ${scope}` : description.preview;
  }
  if (artifact?.path && toolPresentation(description.name) !== "terminal")
    return workspaceRelativePath(artifact.path, artifact.working_dir);
  if (toolPresentation(description.name) !== "terminal") return description.preview;
  const command = description.preview;
  const executable = command.trim().match(/^(?:[A-Za-z_][A-Za-z_0-9]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*([^\s;|&]+)/)?.[1];
  const url = command.match(/https?:\/\/[^\s'";|]+/)?.[0];
  if (executable && url) return `${executable} · ${url}`;
  const firstLine = command.split("\n")[0];
  return firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
}

// Keep the terminal transcript continuous and lossless. The prompt is a visual
// marker; command/output whitespace and literal escape sequences stay intact.
export function terminalRecord(command: string, output: string): string {
  return `${command ? `$ ${command}\n` : ""}${output}`;
}

export function formatToolData(raw: string, format: "compact" | "pretty" = "pretty"): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, format === "pretty" ? 2 : undefined);
  } catch {
    /* Plain tool output is already displayable. */
  }
  return raw;
}

export function toolDuration(group: ToolGroup): string | null {
  if (!group.use || !group.result) return null;
  const elapsed = Date.parse(group.result.ts) - Date.parse(group.use.ts);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return formatElapsed(elapsed);
}

function formatElapsed(elapsed: number): string {
  if (elapsed < 1000) return "< 1 秒";
  if (elapsed < 60000) return `${(elapsed / 1000).toFixed(1)} 秒`;
  return `${Math.floor(elapsed / 60000)} 分 ${Math.floor((elapsed % 60000) / 1000)} 秒`;
}

export function executionLabel(activities: Activity[], live: boolean): string | null {
  if (!live) return null;
  const entries = groupTranscript(activities);
  const latest = entries[entries.length - 1];
  const pending = entries.flatMap((entry) =>
    entry.type === "assistant" && !entry.complete
      ? entry.steps.filter((step): step is ToolGroup => step.type === "tool" && toolStatus(step, live) === "running")
      : [],
  );
  if (latest?.type === "assistant") {
    const lastStep = latest.steps[latest.steps.length - 1];
    if (!latest.complete && lastStep?.type === "intercept") return "审批请求已提交";
  }
  if (pending.length)
    return `正在${describeTool(pending[0]).title}${pending.length > 1 ? ` · ${pending.length} 个调用` : "…"}`;
  if (latest?.type === "assistant") {
    if (latest.complete) return null;
    const lastStep = latest.steps[latest.steps.length - 1];
    if (lastStep?.type === "thinking") return "Agent 正在运行 · 已收到思考内容";
  }
  return "Agent 正在运行…";
}
