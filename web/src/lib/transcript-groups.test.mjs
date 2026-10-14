import {
  assistantTurnPresentation,
  completedToolRuns,
  describeTool,
  executionLabel,
  formatToolData,
  groupToolSequences,
  groupTranscript,
  terminalRecord,
  toolDuration,
  toolInputText,
  toolObject,
  workspaceRelativePath,
  toolPresentation,
  toolStatus,
} from "./transcript-groups.ts";
import assert from "node:assert/strict";
import test from "node:test";

const activity = (seq, kind, extra = {}) => ({
  seq,
  kind,
  worker: "mainagent",
  ts: "2026-10-13T10:00:00Z",
  summary: String(seq),
  ...extra,
});

test("a user turn keeps progress, supplied thinking, tools and answer in one assistant response", () => {
  const entries = groupTranscript([
    activity(1, "user"),
    activity(2, "text"),
    activity(3, "thinking"),
    activity(4, "tool_use", { tool_use_id: "a" }),
    activity(5, "tool_result", { tool_use_id: "a" }),
    activity(6, "result"),
    activity(7, "user"),
    activity(8, "text"),
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["user", "assistant", "user", "assistant"],
  );
  assert.deepEqual(
    entries[1].steps.map((step) => step.type),
    ["progress", "thinking", "tool", "answer"],
  );
  assert.equal(entries[1].complete, true);
  assert.equal(entries[3].complete, false);
});

test("parallel results bind to the correct call without changing execution order", () => {
  const entries = groupTranscript([
    activity(1, "tool_use", { tool_use_id: "a" }),
    activity(2, "tool_use", { tool_use_id: "b" }),
    activity(3, "intercept_request"),
    activity(4, "tool_result", { tool_use_id: "b" }),
    activity(5, "tool_result", { tool_use_id: "a", is_error: true }),
    activity(6, "result"),
  ]);
  const tools = entries[0].steps.filter((step) => step.type === "tool");
  assert.deepEqual(
    tools.map((step) => [step.use.seq, step.result.seq]),
    [
      [1, 5],
      [2, 4],
    ],
  );
  assert.equal(entries[0].steps[2].type, "intercept");
});

test("agent ownership and inherited source prevent tool ID collisions", () => {
  const entries = groupTranscript([
    activity(1, "tool_use", { tool_use_id: "same", worker: "work#1" }),
    activity(2, "tool_use", { tool_use_id: "same", worker: "work#2" }),
    activity(3, "tool_result", { tool_use_id: "same", worker: "work#1" }),
    activity(4, "tool_use", { tool_use_id: "same", worker: "work#1", source_task_id: "99", inherited: true }),
    activity(5, "tool_result", { tool_use_id: "same", worker: "work#1", source_task_id: "99", inherited: true }),
    activity(6, "result", { worker: "work#1" }),
  ]);
  assert.equal(entries[0].steps[0].result.seq, 3);
  assert.equal(entries[1].steps[0].result, undefined);
  assert.equal(entries[2].steps[0].result.seq, 5);
  assert.equal(entries[0].complete, true);
  assert.equal(entries[1].complete, false);
  assert.equal(entries[2].complete, false);
});

test("a missing tool result is running only while its current response is live", () => {
  const group = { type: "tool", key: 1, worker: "mainagent", use: activity(1, "tool_use") };
  assert.equal(toolStatus(group, true), "running");
  assert.equal(toolStatus(group, false), "missing");
  assert.equal(toolStatus(group, true, true), "missing");
  assert.equal(toolStatus({ ...group, use: { ...group.use, inherited: true } }, true), "missing");
  assert.equal(toolStatus({ ...group, result: activity(2, "tool_result", { is_error: true }) }, false), "error");
});

test("a new user turn and a planner round close unfinished previous responses", () => {
  const entries = groupTranscript([
    activity(1, "tool_use"),
    activity(2, "user"),
    activity(3, "thinking"),
    activity(4, "round"),
  ]);
  assert.equal(entries[0].complete, true);
  assert.equal(entries[2].complete, true);
});

test("a generic human role closes the previous interactive response but keeps other agents running", () => {
  const entries = groupTranscript([
    activity(1, "tool_use", { tool_use_id: "old" }),
    activity(2, "tool_use", { worker: "work#1", intent_id: "42", tool_use_id: "worker" }),
    activity(3, "thinking", { worker: "planner" }),
    activity(4, "user", { worker: "user" }),
    activity(5, "tool_use", { tool_use_id: "new" }),
  ]);
  assert.equal(entries[0].complete, true);
  assert.equal(entries[1].complete, false);
  assert.equal(entries[2].complete, false);
  assert.equal(entries[4].complete, false);
  assert.equal(toolStatus(entries[0].steps[0], true, entries[0].complete), "missing");
  assert.equal(toolStatus(entries[1].steps[0], true, entries[1].complete), "running");
});

test("history beginning with a tool result remains readable", () => {
  const entries = groupTranscript([
    activity(9, "tool_result", { tool: "Read", tool_use_id: "older", summary: "file contents" }),
  ]);
  assert.equal(entries[0].steps[0].result.seq, 9);
  assert.equal(toolStatus(entries[0].steps[0], false), "success");
});

test("summaries extract only real command fields even when JSON was truncated", () => {
  const group = {
    type: "tool",
    key: 1,
    worker: "mainagent",
    use: activity(1, "tool_use", { tool: "Bash", summary: 'Bash {"command":"printf \\"hi\\"\\nnext' }),
  };
  assert.deepEqual(describeTool(group), { name: "Bash", title: "执行命令", preview: 'printf "hi"\nnext' });
  assert.equal(toolInputText("Bash", '{"command":"rg src","description":"search"}'), "rg src");
  assert.equal(toolInputText("bash", '{"command":"rg src"}'), "rg src");
  assert.equal(
    describeTool({ ...group, use: { ...group.use, tool: "bash", summary: 'bash {"command":"pwd"}' } }).title,
    "执行命令",
  );
  assert.equal(
    describeTool({ ...group, use: { ...group.use, tool: "custom", summary: "custom {}" } }).title,
    "调用 custom",
  );
});

test("tool duration uses valid recorded timestamps and does not invent missing timing", () => {
  const group = {
    type: "tool",
    key: 1,
    worker: "mainagent",
    use: activity(1, "tool_use"),
    result: activity(2, "tool_result", { ts: "2026-10-13T10:00:02Z" }),
  };
  assert.equal(toolDuration(group), "2.0 秒");
  assert.equal(toolDuration({ ...group, result: { ...group.result, ts: "invalid" } }), null);
  assert.equal(toolDuration({ ...group, result: undefined }), null);
});

test("a human-readable command summary stays visible when detail is explanatory prose", () => {
  const group = {
    type: "tool",
    key: 1,
    worker: "planner",
    use: activity(1, "tool_use", {
      tool: "bash",
      summary: "curl -sI https://example.com",
      detail: "Read the response headers.",
    }),
  };
  assert.equal(describeTool(group).preview, "curl -sI https://example.com");
});

test("execution status follows real latest events and clears after a terminal response", () => {
  assert.equal(executionLabel([activity(1, "user")], true), "Agent 正在运行…");
  assert.equal(executionLabel([activity(2, "tool_use", { tool: "Read" })], true), "正在读取文件…");
  assert.equal(executionLabel([activity(2, "intercept_request")], true), "审批请求已提交");
  assert.equal(executionLabel([activity(2, "thinking")], true), "Agent 正在运行 · 已收到思考内容");
  assert.equal(executionLabel([activity(3, "result")], true), null);
  assert.equal(executionLabel([activity(2, "tool_use")], false), null);
  assert.equal(
    executionLabel(
      [
        activity(1, "tool_use", { worker: "work#1", intent_id: "42", tool: "Read", tool_use_id: "worker" }),
        activity(2, "result"),
      ],
      true,
    ),
    "正在读取文件…",
  );
});

test("grouping does not mutate persisted activities", () => {
  const rows = Object.freeze([
    Object.freeze(activity(1, "tool_use", { tool_use_id: "a" })),
    Object.freeze(activity(2, "tool_result", { tool_use_id: "a" })),
  ]);
  assert.equal(groupTranscript(rows)[0].steps[0].result.seq, 2);
});

test("tool disclosures retain sequence identity as parallel results arrive and stop at public prose or approvals", () => {
  const rows = [
    activity(1, "text", { summary: "检查入口文件。" }),
    activity(2, "tool_use", { tool_use_id: "a" }),
    activity(3, "tool_use", { tool_use_id: "b" }),
    activity(4, "text", { summary: "发现两个配置项。" }),
    activity(5, "tool_use", { tool_use_id: "c" }),
    activity(6, "intercept_request"),
    activity(7, "tool_use", { tool_use_id: "d" }),
  ];
  const before = groupToolSequences(groupTranscript(rows)[0].steps);
  const after = groupToolSequences(
    groupTranscript([
      ...rows,
      activity(8, "tool_result", { tool_use_id: "b" }),
      activity(9, "tool_result", { tool_use_id: "a" }),
    ])[0].steps,
  );
  assert.deepEqual(
    before.map((step) => [step.type, step.key]),
    [
      ["progress", 1],
      ["tool-sequence", 2],
      ["progress", 4],
      ["tool-sequence", 5],
      ["intercept", 6],
      ["tool-sequence", 7],
    ],
  );
  assert.deepEqual(
    after.map((step) => [step.type, step.key]),
    before.map((step) => [step.type, step.key]),
  );
  assert.deepEqual(
    after[1].tools.map((tool) => [tool.use.seq, tool.result.seq]),
    [
      [2, 9],
      [3, 8],
    ],
  );
});

test("folded success runs never absorb an error, a live call or a missing result", () => {
  const tool = (key, result) => ({
    type: "tool",
    key,
    worker: "mainagent",
    use: activity(key, "tool_use"),
    ...(result ? { result: activity(key + 100, "tool_result", result) } : {}),
  });
  const tools = [tool(1, {}), tool(2, {}), tool(3, { is_error: true }), tool(4, {}), tool(5), tool(6, {}), tool(7, {})];
  const keys = (runs) => runs.map((run) => run.map((item) => item.key));
  assert.deepEqual(keys(completedToolRuns(tools, true, false)), [[1, 2], [3], [4], [5], [6, 7]]);
  assert.deepEqual(keys(completedToolRuns(tools, false, true)), [[1, 2], [3], [4], [5], [6, 7]]);
  tools[4].result = activity(105, "tool_result");
  assert.deepEqual(keys(completedToolRuns(tools, true, false)), [[1, 2], [3], [4, 5, 6, 7]]);
});

test("tool object labels show actual paths or command objects without assigning an invented purpose", () => {
  const tool = (name, detail) => ({
    type: "tool",
    key: 1,
    worker: "mainagent",
    use: activity(1, "tool_use", { tool: name, detail }),
  });
  assert.equal(
    toolObject(tool("Bash", '{"command":"TOKEN=test curl -sI https://example.com/api"}')),
    "curl · https://example.com/api",
  );
  assert.equal(toolObject(tool("bash", '{"command":"rg --files web/src\\ncat package.json"}')), "rg --files web/src");
  assert.equal(toolObject(tool("Read", '{"file_path":"web/src/app/page.tsx"}')), "web/src/app/page.tsx");
  assert.equal(toolObject(tool("Grep", '{"pattern":"useEffect"}')), "useEffect");
});

test("tool presentation uses explicit case-insensitive aliases with readable titles", () => {
  const aliases = [
    ["terminal", "执行命令", ["Bash", "shell", "Terminal", "exec_command"]],
    ["summary", "读取文件", ["Read", "readfile", "read_file"]],
    ["summary", "搜索内容", ["Grep", "ripgrep", "search"]],
    ["summary", "查找文件", ["Glob"]],
    ["summary", "查看目录", ["LS", "list_directory"]],
    ["summary", "搜索网页", ["WebSearch", "web_search"]],
    ["summary", "读取网页", ["WebFetch", "web_fetch"]],
    ["summary", "查看任务态势", ["graph_overview"]],
    ["summary", "查看资产", ["list_assets"]],
  ];
  for (const [presentation, title, names] of aliases) {
    for (const name of names.flatMap((alias) => [alias, alias.toUpperCase()])) {
      assert.equal(toolPresentation(name), presentation, name);
      assert.equal(
        describeTool({ type: "tool", key: 1, worker: "mainagent", use: activity(1, "tool_use", { tool: name }) }).title,
        title,
        name,
      );
    }
  }
});

test("write operations, task output and unknown tools retain full details regardless of name prefixes", () => {
  for (const name of [
    "Write",
    "Edit",
    "MultiEdit",
    "TaskOutput",
    "get_worker_output",
    "TodoWrite",
    "mcp__files__read_file",
    "mcp__terminal__exec_command",
    "search_and_replace",
    "read_database_and_delete",
    "list_directory_recursive_custom",
    "BashCustom",
    "",
  ])
    assert.equal(toolPresentation(name), "detail", name);
  assert.equal(toolInputText("mcp__terminal__exec_command", '{"cmd":"pwd"}'), '{"cmd":"pwd"}');
  assert.equal(toolInputText("Read", '{"file_path":"src/app.tsx"}'), '{"file_path":"src/app.tsx"}');
});

test("all terminal aliases extract command or cmd and share command object formatting", () => {
  for (const name of ["Bash", "SHELL", "Terminal", "exec_command"]) {
    for (const field of ["command", "cmd"]) {
      const command = "TOKEN=test curl -sI https://example.com/api\nprintf '%s' '\\n'";
      const detail = JSON.stringify({ [field]: command, timeout_ms: 1000 });
      const group = { type: "tool", key: 1, worker: "mainagent", use: activity(1, "tool_use", { tool: name, detail }) };
      assert.equal(toolInputText(name, detail), command);
      assert.equal(describeTool(group).preview, command);
      assert.equal(toolObject(group), "curl · https://example.com/api");
    }
    assert.equal(toolInputText(name, '{"cmd":"printf \\"hi\\"\\nnext'), 'printf "hi"\nnext');
    assert.equal(toolInputText(name, "pwd"), "pwd");
  }
});

test("search objects retain their query and an explicitly supplied file scope", () => {
  for (const name of ["Grep", "RIPGREP", "search", "Glob"]) {
    for (const [queryField, scopeField] of [
      ["pattern", "path"],
      ["query", "file_path"],
    ]) {
      const group = {
        type: "tool",
        key: 1,
        worker: "mainagent",
        use: activity(1, "tool_use", {
          tool: name,
          detail: JSON.stringify({ [queryField]: "evidence", [scopeField]: "reports/" }),
        }),
      };
      assert.equal(describeTool(group).preview, "evidence");
      assert.equal(toolObject(group), "evidence · reports/");
    }
  }
  const fromSummary = {
    type: "tool",
    key: 1,
    worker: "mainagent",
    use: activity(1, "tool_use", {
      tool: "Grep",
      summary: 'Grep {"pattern":"evidence"}',
      detail: '{"path":"reports/"}',
    }),
  };
  assert.equal(describeTool(fromSummary).preview, "evidence");
  assert.equal(toolObject(fromSummary), "evidence · reports/");
});

test("web searches need no invented scope and unknown tools do not acquire search semantics", () => {
  const group = (name, detail) => ({
    type: "tool",
    key: 1,
    worker: "mainagent",
    use: activity(1, "tool_use", { tool: name, detail }),
  });
  for (const name of ["WebSearch", "WEB_SEARCH"]) {
    assert.equal(describeTool(group(name, '{"query":"agent UI"}')).preview, "agent UI");
    assert.equal(toolObject(group(name, '{"query":"agent UI"}')), "agent UI");
  }
  assert.equal(toolObject(group("Grep", '{"path":"reports/"}')), "reports/");
  const unknown = group("mcp__files__search", '{"pattern":"evidence","path":"reports/"}');
  assert.equal(describeTool(unknown).preview, "reports/");
  assert.equal(toolObject(unknown), "reports/");
});

test("output-only tools use the result name without inventing a command from execution output", () => {
  for (const [name, title, presentation] of [
    ["EXEC_COMMAND", "执行命令", "terminal"],
    ["read_file", "读取文件", "summary"],
    ["TaskOutput", "读取任务输出", "detail"],
    ["mcp__files__read_file", "调用 mcp__files__read_file", "detail"],
  ]) {
    const output = "first line\n$ echoed text\nliteral \\n";
    const group = {
      type: "tool",
      key: 1,
      worker: "mainagent",
      result: activity(1, "tool_result", { tool: name, summary: output, detail: output }),
    };
    assert.deepEqual(describeTool(group), { name, title, preview: "" });
    assert.equal(toolPresentation(describeTool(group).name), presentation);
    assert.equal(toolObject(group), "");
    assert.equal(terminalRecord(toolInputText(name, ""), output), output);
  }
});

test("terminal records keep complete long output, real newlines and literal escapes", () => {
  const output = Array.from({ length: 64 }, (_, index) => `line ${index + 1}`).join("\n");
  assert.equal(terminalRecord("cat report.txt", output), `$ cat report.txt\n${output}`);
  assert.equal(terminalRecord("printf '%s' '\\n'", "literal \\n\n"), "$ printf '%s' '\\n'\nliteral \\n\n");
  assert.equal(terminalRecord("", output), output);
  assert.equal(terminalRecord("pwd", ""), "$ pwd\n");
  assert.equal(formatToolData("plain \\n output"), "plain \\n output");
  assert.equal(formatToolData('{"text":"first\\nsecond"}'), '{\n  "text": "first\\nsecond"\n}');
  assert.equal(formatToolData('{"unfinished":'), '{"unfinished":');
});

test("finished ordinary chat separates only trailing text from its work without changing stored events", () => {
  const turn = groupTranscript([
    activity(1, "text", { summary: "检查配置。" }),
    activity(2, "tool_use", { tool_use_id: "read" }),
    activity(3, "tool_result", { tool_use_id: "read" }),
    activity(4, "text", { summary: "配置已经更新。" }),
    activity(5, "text", { summary: "可以刷新预览。" }),
  ])[0];
  const view = assistantTurnPresentation(turn, false);
  assert.deepEqual(
    view.process.map((step) => step.type),
    ["progress", "tool"],
  );
  assert.deepEqual(
    view.response.map((step) => step.type),
    ["answer"],
  );
  assert.deepEqual(
    view.response[0].steps.map((row) => row.seq),
    [4, 5],
  );
  assert.equal(turn.steps[2].type, "progress");
  assert.equal(turn.complete, false);
  assert.equal(view.toolCount, 1);
  assert.equal(view.errorCount, 0);
  assert.equal(view.hasAttention, false);
});

test("live text remains progress, but an earlier completed turn can expose its final text", () => {
  const rows = [activity(1, "text"), activity(2, "thinking"), activity(3, "text")];
  const liveTurn = groupTranscript(rows)[0];
  assert.equal(assistantTurnPresentation(liveTurn, true).response.length, 0);
  const closedTurn = groupTranscript([...rows, activity(4, "user")])[0];
  assert.equal(closedTurn.complete, true);
  assert.equal(assistantTurnPresentation(closedTurn, true).response[0].key, 3);
});

test("explicit answers remain answers and presentation never moves prose across later approvals or tools", () => {
  const turn = groupTranscript([activity(1, "thinking"), activity(2, "result")])[0];
  assert.equal(assistantTurnPresentation(turn, true).response[0], turn.steps[1]);
  for (const later of [
    { type: "intercept", key: 3, step: activity(3, "intercept_request") },
    { type: "tool", key: 3, worker: "mainagent", use: activity(3, "tool_use") },
  ]) {
    const extended = { ...turn, steps: [...turn.steps, later] };
    const view = assistantTurnPresentation(extended, false);
    assert.deepEqual(view.process, extended.steps);
    assert.deepEqual(view.response, []);
  }
  const approvalTail = groupTranscript([activity(1, "text"), activity(2, "intercept_request")])[0];
  assert.deepEqual(
    assistantTurnPresentation(approvalTail, false).process.map((step) => step.key),
    [1, 2],
  );
});

test("failover notices and errors are not inferred as final answers", () => {
  for (const final of [
    activity(3, "llm_switch"),
    activity(3, "llm_failover", { is_error: true }),
    activity(3, "text", { is_error: true }),
  ]) {
    const turn = groupTranscript([activity(1, "thinking"), activity(2, "text"), final])[0];
    const view = assistantTurnPresentation(turn, false);
    assert.equal(view.response.length, 0);
    assert.deepEqual(view.process, turn.steps);
    assert.equal(view.errorCount, final.is_error ? 1 : 0);
    assert.equal(view.hasAttention, !!final.is_error);
  }
});

test("finished chat keeps configuration notices in process and exposes subsequent final text", () => {
  for (const notice of [activity(2, "llm_switch"), activity(2, "llm_failover", { is_error: true })]) {
    const rows = [activity(1, "text"), notice, activity(3, "text"), activity(4, "text")];
    const turn = groupTranscript(rows)[0];
    const original = structuredClone(turn);
    Object.freeze(turn.steps[0].steps);
    Object.freeze(turn.steps[0]);
    Object.freeze(turn.steps);
    Object.freeze(turn);
    const view = assistantTurnPresentation(turn, false);
    assert.equal(view.process[0].type, "progress");
    assert.equal(view.process[0].key, 1);
    assert.deepEqual(
      view.process[0].steps.map((row) => row.seq),
      [1, 2],
    );
    assert.equal(view.response[0].type, "answer");
    assert.equal(view.response[0].key, 3);
    assert.deepEqual(
      view.response[0].steps.map((row) => row.seq),
      [3, 4],
    );
    assert.deepEqual([...view.process[0].steps, ...view.response[0].steps], rows);
    assert.deepEqual(turn, original);
    assert.equal(view.errorCount, notice.is_error ? 1 : 0);
    assert.equal(view.hasAttention, !!notice.is_error);
    assert.equal(assistantTurnPresentation(turn, true).response.length, 0);
    assert.equal(assistantTurnPresentation({ ...turn, complete: true }, true).response[0].key, 3);
  }
  const noticeFirst = groupTranscript([activity(1, "llm_switch"), activity(2, "text"), activity(3, "text")])[0];
  const view = assistantTurnPresentation(noticeFirst, false);
  assert.deepEqual(
    view.process[0].steps.map((row) => row.seq),
    [1],
  );
  assert.deepEqual(
    view.response[0].steps.map((row) => row.seq),
    [2, 3],
  );
  assert.equal(view.response[0].key, 2);
  const noticeLast = groupTranscript([activity(1, "text"), activity(2, "llm_switch")])[0];
  assert.deepEqual(assistantTurnPresentation(noticeLast, false).process, noticeLast.steps);
  assert.deepEqual(assistantTurnPresentation(noticeLast, false).response, []);
});

test("attention preserves failed tools, approvals and ended calls with missing results", () => {
  const turn = groupTranscript([
    activity(1, "tool_use", { tool_use_id: "failed" }),
    activity(2, "tool_result", { tool_use_id: "failed", is_error: true }),
    activity(3, "intercept_request"),
    activity(4, "tool_use", { tool_use_id: "missing" }),
    activity(5, "result"),
  ])[0];
  const view = assistantTurnPresentation(turn, false);
  assert.equal(view.toolCount, 2);
  assert.equal(view.errorCount, 1);
  assert.equal(view.hasAttention, true);
  assert.deepEqual(
    view.process.map((step) => step.key),
    [1, 3, 4],
  );
  assert.equal(view.response[0].key, 5);
  const approval = groupTranscript([activity(1, "intercept_request")])[0];
  assert.equal(assistantTurnPresentation(approval, true).hasAttention, true);
  const pending = groupTranscript([activity(1, "tool_use")])[0];
  assert.equal(assistantTurnPresentation(pending, true).hasAttention, false);
  assert.equal(assistantTurnPresentation(pending, false).hasAttention, true);
});

test("parallel work duration is recorded wall time and tool-result pairing stays unchanged", () => {
  const turn = groupTranscript([
    activity(1, "tool_use", { tool_use_id: "slow", ts: "2026-10-13T10:00:00Z" }),
    activity(2, "tool_use", { tool_use_id: "fast", ts: "2026-10-13T10:00:01Z" }),
    activity(3, "tool_result", { tool_use_id: "fast", ts: "2026-10-13T10:00:05Z" }),
    activity(4, "tool_result", { tool_use_id: "slow", ts: "2026-10-13T10:00:10Z" }),
    activity(5, "text", { ts: "2026-10-13T10:00:11Z" }),
  ])[0];
  const view = assistantTurnPresentation(turn, false);
  assert.equal(view.duration, "11.0 秒");
  assert.equal(view.toolCount, 2);
  assert.deepEqual(
    view.process.map((step) => [step.use.seq, step.result.seq]),
    [
      [1, 4],
      [2, 3],
    ],
  );
  assert.equal(view.response[0].key, 5);
});

test("turn duration requires actual valid ordered timestamps and never uses a wall-clock timer", () => {
  assert.equal(assistantTurnPresentation(groupTranscript([activity(1, "text")])[0], false).duration, null);
  const turn = (timestamps) => groupTranscript(timestamps.map((ts, index) => activity(index + 1, "text", { ts })))[0];
  for (const timestamps of [
    ["invalid", "2026-10-13T10:00:03Z"],
    ["2026-10-13T10:00:00Z", ""],
    ["2026-10-13T10:00:03Z", "2026-10-13T10:00:00Z"],
    ["2026-10-13T10:00:00Z", "invalid", "2026-10-13T10:00:03Z"],
    ["2026-10-13T10:00:00Z", "2026-10-13T10:00:04Z", "2026-10-13T10:00:03Z"],
  ])
    assert.equal(assistantTurnPresentation(turn(timestamps), false).duration, null);
  const valid = turn(["2026-10-13T10:00:00Z", "2026-10-13T10:01:02Z"]);
  assert.equal(assistantTurnPresentation(valid, false).duration, "1 分 2 秒");
  assert.equal(assistantTurnPresentation(valid, true).duration, "1 分 2 秒");
  assert.equal(assistantTurnPresentation({ ...valid, steps: [] }, false).duration, null);
});

// Real tools often return absolute paths; labels must retain the file identity.
test("workspace display paths shorten only within the recorded working directory", () => {
  assert.equal(workspaceRelativePath("/data/conv-1/uploads/check.txt", "/data/conv-1/"), "uploads/check.txt");
  assert.equal(workspaceRelativePath("/data/conv-10/check.txt", "/data/conv-1"), "/data/conv-10/check.txt");
  assert.equal(workspaceRelativePath("/data/conv-1", "/data/conv-1"), ".");
  assert.equal(workspaceRelativePath("/elsewhere/check.txt"), "/elsewhere/check.txt");
  const search = {
    type: "tool", key: 1, worker: "auto",
    use: activity(1, "tool_use", { tool: "Grep", detail: JSON.stringify({pattern: "reviewed", path: "/data/conv-1/uploads/check.txt"}) }),
    result: activity(2, "tool_result", { tool: "Grep", metadata: {tool_artifact: {version: 1, kind: "search", path: "/data/conv-1/uploads/check.txt", working_dir: "/data/conv-1"}} }),
  };
  assert.equal(toolObject(search), "reviewed · uploads/check.txt");
  assert.equal(search.result.metadata.tool_artifact.path, "/data/conv-1/uploads/check.txt");
});
