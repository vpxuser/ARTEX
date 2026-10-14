"use client";

import * as React from "react";

import {
  Bot,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  CircleX,
  Clock3,
  Copy,
  CrosshairIcon,
  LoaderCircle,
  PaperclipIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { ApprovalDetail } from "@/components/approval-records";
import { Markdown } from "@/components/markdown";
import { useToolInspectorOptional } from "@/components/tool-inspector";
import { ActivityIcon, toolIconKind } from "@/components/transcript-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { api } from "@/lib/api";
import { toolInspectorKind } from "@/lib/tool-inspector";
import type { AssistantTurn, ToolGroup, ToolSequence, TranscriptStep } from "@/lib/transcript-groups";
import {
  assistantTurnPresentation,
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
} from "@/lib/transcript-groups";
import type { Activity, InterceptPending } from "@/lib/types";

// ---- per-agent lane color (planner + work#1/#2/#3 …) ---------------------------
const workerColors = ["bg-sky-600", "bg-violet-600", "bg-teal-600", "bg-pink-600", "bg-orange-600"];
function workerColor(name: string): string {
  if (name === "planner") return "bg-amber-600"; // the intent generator, distinct
  if (name === "mainagent") return "bg-primary";
  const m = /#(\d+)/.exec(name);
  const i = m ? (parseInt(m[1], 10) - 1) % workerColors.length : 0;
  return workerColors[Math.max(0, i)];
}

function workerLabel(worker: string): string {
  if (worker === "mainagent") return "主 Agent";
  if (worker === "planner") return "规划 Agent";
  if (worker === "system") return "系统";
  const match = /^work#(\d+)$/.exec(worker);
  return match ? `执行 Agent ${match[1]}` : worker;
}

// useInView latches true when the ref'd element first comes within `rootMargin` of
// the enclosing scroll viewport. Blocks that always show their full body (user
// bubbles, answers) use it to defer fetching that body until they're about to be
// seen — so opening a long thread doesn't fire a detail request for every off-
// screen step. Observes the ScrollArea viewport (falls back to eager load when
// IntersectionObserver is unavailable, e.g. SSR).
function useInView(rootMargin = "400px"): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = React.useState(false);
  React.useEffect(() => {
    if (inView) return; // latch: once seen, stop observing
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const root = el.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { root, rootMargin },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [inView, rootMargin]);
  return [ref, inView];
}

function ActivityTime({ ts }: { ts: string }) {
  const date = new Date(ts);
  if (!ts || Number.isNaN(date.getTime())) return null;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString("zh-CN")}
      className="text-[10px] text-muted-foreground tabular-nums"
      suppressHydrationWarning
    >
      {date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}
    </time>
  );
}

type DetailFetcher = (seq: number) => Promise<string>;
export type TranscriptMode = "conversation" | "execution";

function useActivityDetails(steps: Activity[], enabled: boolean, getDetail: DetailFetcher) {
  const key = steps.map((step) => `${step.seq}:${step.detail ?? ""}`).join("\n");
  const stepsRef = React.useRef(steps);
  stepsRef.current = steps;
  const [revision, setRevision] = React.useState(0);
  const [state, setState] = React.useState<{ key: string; parts: string[]; error: boolean; loading: boolean }>({
    key: "",
    parts: [],
    error: false,
    loading: false,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry reloads the same activity details after a failed request.
  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    const pending = stepsRef.current;
    setState((current) => ({ key, parts: current.key === key ? current.parts : [], error: false, loading: true }));
    void Promise.allSettled(
      pending.map((step) => (step.detail ? Promise.resolve(step.detail) : getDetail(step.seq))),
    ).then((results) => {
      if (!active) return;
      setState({
        key,
        parts: results.map((result, index) =>
          result.status === "fulfilled" ? result.value || pending[index].summary : pending[index].summary,
        ),
        error: results.some((result) => result.status === "rejected"),
        loading: false,
      });
    });
    return () => {
      active = false;
    };
  }, [enabled, key, getDetail, revision]);

  const current = state.key === key;
  return {
    parts:
      current && state.parts.length === steps.length ? state.parts : steps.map((step) => step.detail || step.summary),
    error: current && state.error,
    loading: enabled && (!current || state.loading),
    ready: current && !state.loading,
    retry: () => setRevision((value) => value + 1),
  };
}

function DetailError({ retry }: { retry: () => void }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
      <span>完整内容加载失败，当前显示摘要。</span>
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={retry}>
        重试
      </Button>
    </div>
  );
}

function CopyDetail({ text, label, disabled }: { text: string; label: string; disabled?: boolean }) {
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timerRef.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("复制失败，请手动选择内容复制");
    }
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 rounded-md text-muted-foreground hover:text-foreground"
      aria-label={label}
      title={copied ? "已复制" : label}
      disabled={disabled ? true : !text}
      onClick={() => void copy()}
      data-copy-action
    >
      {copied ? <CheckIcon className="size-3.5" /> : <Copy className="size-3.5" />}
      <span className="sr-only" role="status">
        {copied ? "已复制" : ""}
      </span>
    </Button>
  );
}

// InterceptCard renders an inline intercept_request approval card. The pending_id
// is extracted from the summary (format: "工具 X 请求审批 (#N)") so buttons are
// available immediately without waiting for the detail load.
function InterceptCard({ step, getDetail }: { step: Activity; getDetail: (seq: number) => Promise<string> }) {
  // extract pending_id from summary: "工具 Bash 请求审批 (#42)"
  const pendingId = React.useMemo(() => {
    const m = /\(#(\d+)\)/.exec(step.summary);
    return m ? parseInt(m[1], 10) : null;
  }, [step.summary]);

  const toolName = React.useMemo(() => {
    const m = /工具\s+(\S+)\s+请求/.exec(step.summary);
    return m ? m[1] : step.summary;
  }, [step.summary]);

  const [detail, setDetail] = React.useState<Record<string, unknown> | null>(null);
  const [decided, setDecided] = React.useState<"allowed" | "denied" | "timeout" | null>(null);
  const [deciding, setDeciding] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [pending, setPending] = React.useState<InterceptPending | null>(null);
  const [statusError, setStatusError] = React.useState("");
  const [retry, setRetry] = React.useState(0);

  // Load persisted detail JSON + check the real current status from the backend
  // so that a page refresh shows the already-decided state instead of re-offering buttons.
  React.useEffect(() => {
    let live = true;
    getDetail(step.seq)
      .then((raw) => {
        if (!live || !raw) return;
        try {
          setDetail(JSON.parse(raw));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      live = false;
    };
  }, [step.seq, getDetail]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the same approval after a failed request.
  React.useEffect(() => {
    if (!pendingId) return;
    let live = true;
    api
      .interceptGetOne(pendingId)
      .then((p) => {
        if (!live) return;
        setPending(p);
        setStatusError("");
        if (p.status !== "pending") setDecided(p.status as "allowed" | "denied" | "timeout");
      })
      .catch((error) => {
        if (live) setStatusError((error as Error).message || "审批详情加载失败");
      });
    return () => {
      live = false;
    };
  }, [pendingId, retry]);

  async function decide(decision: "allowed" | "denied") {
    if (step.inherited || !pendingId || deciding) return;
    setDeciding(true);
    try {
      await api.interceptDecide(pendingId, decision);
      setDecided(decision);
      toast.success(decision === "allowed" ? "已允许执行" : "已拒绝执行");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeciding(false);
    }
  }

  const inputStr = detail?.input ? JSON.stringify(detail.input).slice(0, 200) : null;

  const row = pending
    ? { ...pending, status: decided || pending.status, conv_title: "", conv_agent_key: "", rule_name: "" }
    : null;

  return (
    <div className="my-2 rounded-lg border border-amber-400/50 bg-amber-50/40 dark:bg-amber-950/15 p-3 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <ShieldAlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-1.5 font-medium">
              <span className="text-amber-700 dark:text-amber-400">审批请求</span>
              <code className="rounded bg-amber-100 dark:bg-amber-900/50 px-1 font-mono text-amber-800 dark:text-amber-300">
                {toolName}
              </code>
              {pendingId && <span className="text-muted-foreground">#{pendingId}</span>}
            </div>
            {inputStr && <p className="font-mono text-muted-foreground truncate">{inputStr}</p>}
          </div>
        </div>

        {step.inherited ? (
          <Badge variant="outline">历史记录 · 只读</Badge>
        ) : decided ? (
          <span
            className={
              "shrink-0 rounded px-2 py-0.5 text-[11px] font-medium " +
              (decided === "allowed"
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                : decided === "timeout"
                  ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400")
            }
          >
            {decided === "allowed" ? "已允许" : decided === "timeout" ? "已超时" : "已拒绝"}
          </span>
        ) : (
          <div className="flex shrink-0 gap-1.5">
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={deciding || !pendingId}
              onClick={() => decide("allowed")}
            >
              <CheckIcon className="h-3 w-3" />
              允许
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-6 px-2 text-xs"
              disabled={deciding || !pendingId}
              onClick={() => decide("denied")}
            >
              <XIcon className="h-3 w-3" />
              拒绝
            </Button>
          </div>
        )}
      </div>
      {pendingId ? (
        <Collapsible open={expanded} onOpenChange={setExpanded} className="mt-2 min-w-0">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={expanded ? "收起审批详情" : "展开审批详情"}>
              {expanded ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
              {expanded ? "收起审批详情" : "展开审批详情"}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {expanded && row ? (
              <ApprovalDetail
                row={row}
                busy={deciding}
                decide={(_id, decision) => decide(decision)}
                revision={retry}
                readOnly={Boolean(step.inherited)}
                defaultExpanded
                onResolved={setDecided}
              />
            ) : statusError ? (
              <div className="flex flex-wrap items-center gap-2 p-3" role="alert">
                <span>{statusError}</span>
                <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
                  重试详情
                </Button>
              </div>
            ) : (
              <p className="p-3 text-muted-foreground">正在加载审批详情…</p>
            )}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

// Keep the call and its matching result together, including parallel executions.
const toolStates = {
  running: { Icon: LoaderCircle, label: "执行中", tone: "text-muted-foreground" },
  success: { Icon: CheckIcon, label: "完成", tone: "text-muted-foreground" },
  error: { Icon: CircleX, label: "失败", tone: "text-destructive" },
  missing: { Icon: Clock3, label: "未收到执行结果", tone: "text-muted-foreground" },
};

function ToolSequenceBlock({
  sequence,
  getDetail,
  live,
  complete,
  focusedSeq,
  visible,
  onInspect,
}: {
  sequence: ToolSequence;
  getDetail: DetailFetcher;
  live: boolean;
  complete: boolean;
  focusedSeq?: number;
  visible: boolean;
  onInspect: () => void;
}) {
  // Stable call keys preserve disclosures when parallel results arrive.
  const [views, setViews] = React.useState(new Map<number, boolean>());
  const changeOpen = React.useCallback((key: number, open: boolean) => {
    setViews((current) => new Map(current).set(key, open));
  }, []);
  return (
    <div className="my-2 min-w-0 space-y-0.5" data-tool-sequence>
      {sequence.tools.map((tool) => (
        <ToolBlock
          key={tool.key}
          group={tool}
          getDetail={getDetail}
          live={live}
          complete={complete}
          focused={focusedSeq != null && (tool.use?.seq === focusedSeq || tool.result?.seq === focusedSeq)}
          open={views.get(tool.key) ?? (toolPresentation(tool.use?.tool || tool.result?.tool || "") === "terminal" || Boolean(tool.result?.is_error))}
          visible={visible}
          onOpenChange={changeOpen}
          onInspect={onInspect}
        />
      ))}
    </div>
  );
}

// biome-ignore-start lint/a11y/noNoninteractiveTabindex: Scrollable execution records need keyboard focus.
function ExecutionOutput({
  label,
  children,
  compact = false,
}: {
  label: string;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <section
      aria-label={label}
      tabIndex={0}
      className={
        "overflow-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring " +
        (compact ? "max-h-40" : "max-h-[28rem] px-3 py-2.5")
      }
    >
      <pre
        className={
          "font-mono text-xs leading-relaxed " +
          (compact ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre pr-10")
        }
      >
        {children}
      </pre>
    </section>
  );
}
// biome-ignore-end lint/a11y/noNoninteractiveTabindex: End execution record focus region.

function ToolBlock({
  group,
  getDetail,
  live,
  complete,
  focused = false,
  open,
  visible,
  onOpenChange,
  onInspect,
}: {
  group: ToolGroup;
  getDetail: DetailFetcher;
  live: boolean;
  complete: boolean;
  focused?: boolean;
  open: boolean;
  visible: boolean;
  onOpenChange: (key: number, value: boolean) => void;
  onInspect: () => void;
}) {
  const targetRef = React.useRef<HTMLElement>(null);
  const inspector = useToolInspectorOptional();
  const { use, result } = group;
  const description = describeTool(group);
  const object = toolObject(group);
  const status = toolStatus(group, live, complete);
  const duration = toolDuration(group);
  const presentation = toolPresentation(description.name);
  const inspectable = Boolean(inspector && toolInspectorKind(description.name) !== "raw");
  const summaryOnly = presentation === "summary" || (inspectable && toolInspectorKind(description.name) === "change");
  const isTerminal = presentation === "terminal";
  // Routine exploration is a static activity row. Only failures need a body;
  // successful reads/searches neither fetch nor mount the raw result.
  const details = useActivityDetails(
    summaryOnly ? (result ? [result] : []) : [...(use ? [use] : []), ...(result ? [result] : [])],
    visible && (summaryOnly ? status === "error" : open),
    getDetail,
  );
  const input = use ? toolInputText(description.name, details.parts[0] ?? "") : "";
  const output = result ? (details.parts[!summaryOnly && use ? 1 : 0] ?? "") : "";
  const { label: statusLabel, tone: statusTone } = toolStates[status];

  React.useEffect(() => {
    if (!summaryOnly && (focused || result?.is_error)) onOpenChange(group.key, true);
  }, [focused, result?.is_error, group.key, onOpenChange, summaryOnly]);

  const scrolledRef = React.useRef(false);
  React.useEffect(() => {
    if (!focused) scrolledRef.current = false;
  }, [focused]);
  React.useEffect(() => {
    if (
      !focused ||
      !visible ||
      (!summaryOnly && !open) ||
      ((!summaryOnly || status === "error") && !details.ready) ||
      scrolledRef.current
    )
      return;
    const el = targetRef.current;
    const viewport = el?.closest('[data-slot="scroll-area-viewport"]');
    if (!el || !viewport) return;
    const center = () => {
      scrolledRef.current = true;
      const rect = el.getBoundingClientRect();
      const bounds = viewport.getBoundingClientRect();
      viewport.scrollTop += rect.top + rect.height / 2 - bounds.top - bounds.height / 2;
    };
    const observer = new ResizeObserver(center);
    observer.observe(el.parentElement ?? el);
    observer.observe(viewport);
    const stop = () => observer.disconnect();
    viewport.addEventListener("wheel", stop, { passive: true, once: true });
    viewport.addEventListener("touchstart", stop, { passive: true, once: true });
    viewport.addEventListener("pointerdown", stop, { once: true });
    const frame = requestAnimationFrame(center);
    const timer = setTimeout(stop, 2000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      stop();
      viewport.removeEventListener("wheel", stop);
      viewport.removeEventListener("touchstart", stop);
      viewport.removeEventListener("pointerdown", stop);
    };
  }, [focused, visible, open, details.ready, summaryOnly, status]);

  const copyDisabled = details.loading || details.error;
  const rowClass = "flex max-w-full min-w-0 items-center gap-2 py-1.5 text-left text-muted-foreground";
  const rowContent = (
    <>
      {status === "running" ? (
        <LoaderCircle aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
      ) : (
        <ActivityIcon kind={toolIconKind(description.name)} className="size-4 shrink-0" />
      )}
      <span className="shrink-0">
        {summaryOnly && status === "success"
          ? description.title.replace(/^(读取|搜索|查找|查看)/, "已$1")
          : description.title}
      </span>
      {inspectable ? (
        <button
          type="button"
          className="min-w-0 truncate rounded-sm font-mono text-[12px] underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:no-underline"
          title={result ? object : "工具返回结果后可查看记录"}
          disabled={!result}
          aria-label={`查看${toolInspectorKind(description.name) === "change" ? "文件变更" : "工具记录"}：${object || description.title}`}
          aria-haspopup="dialog"
          data-tool-inspect
          onClick={() => { onInspect(); inspector?.openTool(group); }}
        >
          {object || "查看记录"}
        </button>
      ) : (
        <span className="min-w-0 truncate font-mono text-[12px]" title={object}>{object}</span>
      )}
      {status === "error" ? (
        <span className="shrink-0 text-xs text-destructive">失败</span>
      ) : status === "missing" ? (
        <span className="shrink-0 text-xs">未收到结果</span>
      ) : (
        <span className="sr-only">{statusLabel}</span>
      )}
    </>
  );

  if (summaryOnly) {
    return (
      <section
        ref={targetRef}
        aria-label={focused ? `定位的工具调用 #${use?.seq ?? result?.seq}` : description.title}
        data-tool-status={status}
        data-tool-presentation="summary"
        className={"group/tool min-w-0 rounded-lg text-[13px] " + (focused ? "ring-2 ring-primary bg-primary/5" : "")}
      >
        <div
          className={rowClass}
          data-tool-row
          title={[description.title, object, statusLabel].filter(Boolean).join(" · ")}
        >
          {rowContent}
        </div>
        {status === "error" && (
          <div className="min-w-0 pb-2 text-destructive" data-tool-error data-copy-scope="tool-error">
            <ExecutionOutput label="工具失败原因" compact>
              {output ||
                (details.loading
                  ? "正在加载失败原因…"
                  : details.error
                    ? "完整失败原因暂不可用。"
                    : "工具执行失败，未返回原因。")}
            </ExecutionOutput>
            <div className="-ml-1.5 mt-1 flex justify-start opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/tool:opacity-100 [@media(hover:hover)]:group-focus-within/tool:opacity-100">
              <CopyDetail text={output} label="复制失败原因" disabled={copyDisabled} />
            </div>
            {details.error && <DetailError retry={details.retry} />}
          </div>
        )}
      </section>
    );
  }

  return (
    <section
      ref={targetRef}
      aria-label={focused ? `定位的工具调用 #${use?.seq ?? result?.seq}` : description.title}
      data-tool-status={status}
      data-tool-presentation={presentation}
      className={"min-w-0 rounded-lg text-[13px] " + (focused ? "ring-2 ring-primary bg-primary/5" : "")}
    >
      <Collapsible
        open={open}
        onOpenChange={(value) => {
          onInspect();
          onOpenChange(group.key, value);
        }}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={
              rowClass +
              " group/tool rounded-md pr-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            }
            data-tool-row
            title={[description.title, object, statusLabel, duration].filter(Boolean).join(" · ")}
          >
            {rowContent}
            <ChevronRight
              aria-hidden="true"
              className={
                "size-3.5 shrink-0 transition-transform motion-reduce:transition-none " + (open ? "rotate-90" : "")
              }
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="min-w-0 pb-2 pt-1">
            {details.loading && (
              <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <LoaderCircle className="size-3 motion-safe:animate-spin" />
                加载完整执行记录…
              </p>
            )}
            <div
              className="group/record relative min-w-0 overflow-hidden rounded-lg border border-border/60 bg-muted/35"
              data-tool-record
              data-copy-scope="tool-record"
            >
              <div className="absolute right-1.5 top-1.5 z-10 rounded-md bg-muted opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/record:opacity-100 [@media(hover:hover)]:group-focus-within/record:opacity-100">
                <CopyDetail
                  text={isTerminal ? terminalRecord(use ? input : "", output) : output}
                  label={isTerminal ? "复制执行记录" : "复制完整工具结果"}
                  disabled={copyDisabled}
                />
              </div>
              {isTerminal ? (
                <ExecutionOutput label="终端执行记录">
                  {use && input && <span className="text-foreground">{`$ ${input}\n`}</span>}
                  <span className={status === "error" ? "text-destructive" : "text-muted-foreground"}>{output}</span>
                </ExecutionOutput>
              ) : result ? (
                <ExecutionOutput label="工具执行记录">
                  {formatToolData(output) ||
                    (details.loading ? "正在加载输出…" : details.error ? "完整输出暂不可用。" : "（无输出）")}
                </ExecutionOutput>
              ) : null}
              {!result && (
                <p className="px-3 pb-3 pt-1 text-xs text-muted-foreground">
                  {status === "running" ? "正在执行…" : "未收到执行结果。"}
                </p>
              )}
              {isTerminal && result && !output && details.ready && !details.error && (
                <p className="px-3 pb-3 text-xs text-muted-foreground">
                  {status === "error" ? "执行失败，未返回输出。" : "执行完成，无输出。"}
                </p>
              )}
              <div className="flex min-w-0 items-center justify-end gap-2 px-3 pb-1 text-[11px] text-muted-foreground">
                {status !== "success" && <span className={statusTone}>{statusLabel}</span>}
                {duration && (
                  <span className="shrink-0 tabular-nums" title="按工具调用与结果记录的时间估算">
                    {duration}
                  </span>
                )}
              </div>
              {!isTerminal && use && (
                <details className="border-t border-border/50 px-3 py-2 text-muted-foreground" data-copy-scope="tool-input">
                  <summary className="cursor-pointer text-[11px]">调用参数</summary>
                  <pre className="max-h-52 overflow-auto whitespace-pre py-2 font-mono text-xs leading-relaxed">
                    {formatToolData(input) || "（空）"}
                  </pre>
                  <div className="-ml-1.5 flex justify-start">
                    <CopyDetail text={input} label="复制工具输入" disabled={copyDisabled} />
                  </div>
                </details>
              )}
            </div>
            {!use && (
              <p className="mt-2 text-xs text-muted-foreground">调用输入不在当前历史页中，可向上加载更早记录。</p>
            )}
            {details.error && <DetailError retry={details.retry} />}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function ThinkingBlock({
  group,
  getDetail,
  focused = false,
  visible = true,
  onInspect,
}: {
  group: Extract<TranscriptStep, { type: "thinking" | "progress" | "answer" }>;
  getDetail: DetailFetcher;
  focused?: boolean;
  visible?: boolean;
  onInspect: () => void;
}) {
  const [open, setOpen] = React.useState(focused);
  React.useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);
  const details = useActivityDetails(group.steps, open && visible, getDetail);
  const text = details.parts.join("\n\n");
  return (
    <Collapsible
      open={open}
      onOpenChange={(value) => {
        onInspect();
        setOpen(value);
      }}
      className="my-2 min-w-0 text-[13px]"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md py-1.5 pr-2 text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ActivityIcon kind="thought" className="size-4 shrink-0" />
          <span>思考</span>
          <ChevronRight
            aria-hidden="true"
            className={
              "size-3.5 shrink-0 transition-transform motion-reduce:transition-none " + (open ? "rotate-90" : "")
            }
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-2 min-w-0 border-l border-border/70 pl-4 pb-2 pt-1 text-muted-foreground [overflow-wrap:anywhere]" data-copy-scope="thinking">
          {details.loading ? <p>加载思考内容…</p> : <Markdown text={text} />}
          <div className="-ml-1.5 mt-1 flex justify-start text-[11px]">
            <CopyDetail text={text} label="复制模型思考内容" disabled={details.loading || details.error} />
          </div>
          {details.error && <DetailError retry={details.retry} />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ProgressBlock({
  group,
  getDetail,
  visible,
}: {
  group: Extract<TranscriptStep, { type: "thinking" | "progress" | "answer" }>;
  getDetail: DetailFetcher;
  visible: boolean;
}) {
  const [ref, inView] = useInView();
  const details = useActivityDetails(group.steps, inView && visible, getDetail);
  const isError = group.steps.some((step) => step.is_error);
  const transition = group.steps.some((step) => step.kind === "llm_switch" || step.kind === "llm_failover");
  return (
    <div
      ref={ref}
      className={
        "my-2 min-w-0 [overflow-wrap:anywhere] " +
        (isError
          ? "rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive"
          : "text-foreground/90")
      }
    >
      {transition && <p className="mb-1 text-xs font-medium text-muted-foreground">模型配置变更</p>}
      <Markdown text={details.parts.join("\n\n")} />
      {details.error && <DetailError retry={details.retry} />}
    </div>
  );
}

// Human turns remain chat bubbles; generated worker intents are goal strips.
// Both keep lazy full-body loading rather than treating truncated summaries as
// the full request. fmtBytes renders attachment sizes.
function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

type MsgAttachment = { name: string; path: string; size: number };

// parseUserBody splits a user turn's body into text + attachments. The backend stores
// Detail as JSON {text, attachments} when files were uploaded, else plain text — so we
// parse defensively and fall back to treating the whole body as text.
function parseUserBody(body: string): { text: string; attachments: MsgAttachment[] } {
  if (body.startsWith("{")) {
    try {
      const p = JSON.parse(body);
      if (p && Array.isArray(p.attachments)) {
        return { text: typeof p.text === "string" ? p.text : "", attachments: p.attachments };
      }
    } catch {
      /* plain text that merely starts with "{" */
    }
  }
  return { text: body, attachments: [] };
}

function UserRow({
  step,
  intent,
  getDetail,
  mode,
}: {
  step: Activity;
  intent?: boolean;
  getDetail: (seq: number) => Promise<string>;
  mode: TranscriptMode;
}) {
  const [ref, inView] = useInView();
  const details = useActivityDetails([step], inView, getDetail);
  const { text, attachments } = parseUserBody(details.parts[0] ?? step.summary);
  if (intent) {
    return (
      <div ref={ref} className="my-2 min-w-0 rounded-md border-l-2 border-primary/50 bg-muted/30 px-3 py-2.5">
        <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <CrosshairIcon className="size-3.5 shrink-0" />
          <span>任务目标</span>
          {mode === "execution" && <ActivityTime ts={step.ts} />}
        </div>
        <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{text}</p>
        {details.error && <DetailError retry={details.retry} />}
      </div>
    );
  }
  return (
    <div ref={ref} className="group/message mt-5 mb-2 flex min-w-0 justify-end" data-message-role="user">
      <div className="flex min-w-0 max-w-[90%] flex-col items-end gap-1.5 sm:max-w-[85%]" data-copy-scope="user">
        {attachments.length > 0 && (
          <div className="flex min-w-0 max-w-full flex-wrap justify-end gap-1.5">
            {attachments.map((a) => (
              <div
                key={a.path}
                className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs shadow-sm"
                title={a.path}
              >
                <PaperclipIcon className="size-3 shrink-0 text-primary" />
                <span className="max-w-[180px] truncate font-medium">{a.name}</span>
                <span className="shrink-0 text-muted-foreground">{fmtBytes(a.size)}</span>
              </div>
            ))}
          </div>
        )}
        {text && (
          <div className="min-w-0 max-w-full whitespace-pre-wrap rounded-2xl bg-muted/70 px-4 py-2.5 text-sm leading-7 text-foreground [overflow-wrap:anywhere]">
            {text}
          </div>
        )}
        {details.error && <DetailError retry={details.retry} />}
        <div className="flex h-7 items-center gap-2 pr-2.5 text-muted-foreground opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/message:opacity-100 [@media(hover:hover)]:group-focus-within/message:opacity-100">
          {mode === "execution" && <ActivityTime ts={step.ts} />}
          <CopyDetail text={text} label="复制消息" disabled={details.loading || details.error} />
        </div>
      </div>
    </div>
  );
}

function AnswerBlock({ step, getDetail }: { step: Activity; getDetail: DetailFetcher }) {
  const [ref, inView] = useInView();
  const details = useActivityDetails([step], inView, getDetail);
  const text = details.parts[0] ?? step.summary;
  return (
    <div
      ref={ref}
      className="group/message my-3 min-w-0 [overflow-wrap:anywhere] [&_p]:leading-7 [&_li]:leading-7"
      data-message-role="assistant"
      data-copy-scope="assistant"
    >
      <div
        className={step.is_error ? "rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive" : ""}
      >
        {step.is_error ? (
          <>
            <p className="mb-1 text-xs font-medium">执行失败</p>
            <p className="whitespace-pre-wrap text-sm">{text}</p>
          </>
        ) : (
          <Markdown text={text} />
        )}
      </div>
      <div className="-ml-1.5 mt-1 h-7 text-muted-foreground opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/message:opacity-100 [@media(hover:hover)]:group-focus-within/message:opacity-100">
        <CopyDetail text={text} label="复制 Agent 结果" disabled={details.loading || details.error} />
      </div>
      {details.error && <DetailError retry={details.retry} />}
    </div>
  );
}

function TurnFileChanges({ steps }: { steps: TranscriptStep[] }) {
  const inspector = useToolInspectorOptional();
  const changes = steps.filter((step): step is ToolGroup =>
    step.type === "tool" && !step.result?.is_error && step.result?.metadata?.tool_artifact?.kind === "change",
  );
  if (!inspector || changes.length === 0) return null;
  const files = new Set(changes.map((step) => step.result?.metadata?.tool_artifact?.path));
  return (
    <section className="mt-2 min-w-0 rounded-lg border border-border/60 px-3 py-2" aria-label="本轮文件变更" data-turn-changes>
      <p className="mb-1 text-xs text-muted-foreground">文件变更 · {files.size} 个文件 · {changes.length} 次操作</p>
      {changes.map((group, index) => {
        const artifact = group.result?.metadata?.tool_artifact;
        if (!artifact) return null;
        const path = workspaceRelativePath(artifact.path, artifact.working_dir);
        return (
          <button
            key={group.key}
            type="button"
            data-tool-inspect
            onClick={() => inspector.openTool(group)}
            className="flex w-full min-w-0 items-center gap-2 rounded py-1 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={`查看第 ${index + 1} 次文件变更：${path}`}
          >
            <ActivityIcon kind="file" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
            <span className="shrink-0 text-muted-foreground">{artifact.operation === "create" ? "新增" : "修改"}{changes.length > files.size ? ` · ${index + 1}` : ""}</span>
          </button>
        );
      })}
    </section>
  );
}

function AssistantResponse({
  entry,
  getDetail,
  live,
  focusedSeq,
}: {
  entry: AssistantTurn;
  getDetail: DetailFetcher;
  live: boolean;
  focusedSeq?: number;
}) {
  const presentation = assistantTurnPresentation(entry, live);
  const { process, response, toolCount, errorCount, hasAttention, duration } = presentation;
  const missingCount = process.filter(
    (step) => step.type === "tool" && toolStatus(step, live, entry.complete) === "missing",
  ).length;
  const [choice, setChoice] = React.useState<boolean | null>(null);
  const focused =
    focusedSeq != null &&
    process.some((step) =>
      step.type === "tool"
        ? step.use?.seq === focusedSeq || step.result?.seq === focusedSeq
        : step.type === "intercept"
          ? step.step.seq === focusedSeq
          : step.steps.some((item) => item.seq === focusedSeq),
    );
  React.useEffect(() => {
    if (focused && focusedSeq != null) setChoice(true);
  }, [focused, focusedSeq]);
  const attentionKey = process
    .flatMap((step) => {
      if (step.type === "intercept") return [`approval:${step.key}`];
      if (step.type === "tool") {
        const status = toolStatus(step, live, entry.complete);
        return status === "error" || status === "missing" ? [`${status}:${step.key}`] : [];
      }
      return step.steps.filter((item) => item.is_error).map((item) => `error:${item.seq}`);
    })
    .join(",");
  React.useEffect(() => {
    // A new failure or approval must surface even if earlier work was folded.
    if (attentionKey) setChoice(true);
  }, [attentionKey]);
  // History folds only when a readable response remains outside. Errors,
  // approvals and missing results stay discoverable and open by default.
  const open = choice ?? (focused || response.length === 0 || hasAttention || (live && !entry.complete));
  const inspect = React.useCallback(() => setChoice(true), []);
  const renderSteps = (steps: TranscriptStep[], visible: boolean) =>
    groupToolSequences(steps).map((step) => {
      if (step.type === "tool-sequence")
        return (
          <ToolSequenceBlock
            key={"tool-sequence" + step.key}
            sequence={step}
            getDetail={getDetail}
            live={live}
            complete={entry.complete}
            focusedSeq={focusedSeq}
            visible={visible}
            onInspect={inspect}
          />
        );
      if (step.type === "intercept")
        return <InterceptCard key={"intercept" + step.key} step={step.step} getDetail={getDetail} />;
      if (step.type === "thinking")
        return (
          <ThinkingBlock
            key={"thinking" + step.key}
            group={step}
            getDetail={getDetail}
            focused={step.steps.some((item) => item.seq === focusedSeq)}
            visible={visible}
            onInspect={inspect}
          />
        );
      if (step.type === "answer")
        return step.steps.map((answer) => (
          <AnswerBlock key={"answer" + answer.seq} step={answer} getDetail={getDetail} />
        ));
      return <ProgressBlock key={"progress" + step.key} group={step} getDetail={getDetail} visible={visible} />;
    });
  return (
    <>
      {process.length > 0 && (
        <Collapsible open={open} onOpenChange={setChoice} className="min-w-0" data-response-process>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md py-1.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-process-toggle
            >
              <span>{live && !entry.complete ? "执行中" : "工作过程"}</span>
              {toolCount > 0 && <span>· {toolCount} 项操作</span>}
              {duration && (
                <span className="tabular-nums" title="根据本轮已记录事件估算，不累计并行工具耗时">
                  · {duration}
                </span>
              )}
              {errorCount > 0 && <span className="text-destructive">· {errorCount} 项异常</span>}
              {missingCount > 0 && <span>· {missingCount} 项未返回</span>}
              <ChevronRight
                aria-hidden="true"
                className={
                  "size-3.5 shrink-0 transition-transform motion-reduce:transition-none " + (open ? "rotate-90" : "")
                }
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent forceMount hidden={!open}>
            <div className="min-w-0 pb-1 pt-1">{renderSteps(process, open)}</div>
          </CollapsibleContent>
        </Collapsible>
      )}
      {renderSteps(response, true)}
      <TurnFileChanges steps={entry.steps} />
    </>
  );
}

function ExecView({
  activity,
  taskId,
  mode,
  live = false,
  fetchDetail,
  focusedSeq,
}: {
  activity: Activity[];
  taskId?: string;
  mode: TranscriptMode;
  live?: boolean;
  fetchDetail?: DetailFetcher;
  focusedSeq?: number;
}) {
  const entries = React.useMemo(() => groupTranscript(activity), [activity]);
  const showWorker =
    new Set(entries.filter((entry) => entry.type === "assistant").map((entry) => entry.worker)).size > 1;
  // Detail requests are shared within this transcript, while rejected requests
  // are removed so the visible retry controls really fetch again.
  const scope = React.useMemo(
    () => ({ taskId, fetchDetail, cache: new Map<number, Promise<string>>() }),
    [taskId, fetchDetail],
  );
  const getDetail = React.useCallback(
    (seq: number) => {
      const saved = scope.cache.get(seq);
      if (saved) return saved;
      const request = (
        scope.fetchDetail
          ? scope.fetchDetail(seq)
          : api.activityDetail(seq, scope.taskId).then((response) => response.detail ?? "")
      ).catch((error) => {
        scope.cache.delete(seq);
        throw error;
      });
      scope.cache.set(seq, request);
      return request;
    },
    [scope],
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {entries.map((entry) => {
        if (entry.type === "round") {
          return (
            <div
              key={"round" + entry.key}
              className="my-3 flex items-center gap-3 text-xs font-medium text-muted-foreground"
            >
              <span className="h-px flex-1 bg-border" />
              {entry.label}
              <span className="h-px flex-1 bg-border" />
            </div>
          );
        }
        if (entry.type === "user")
          return (
            <UserRow
              key={"user" + entry.key}
              step={entry.step}
              intent={entry.intent}
              getDetail={getDetail}
              mode={mode}
            />
          );
        const firstStep = entry.steps[0];
        const timestamp =
          firstStep &&
          ("step" in firstStep
            ? firstStep.step.ts
            : "steps" in firstStep
              ? firstStep.steps[0]?.ts
              : firstStep.use?.ts || firstStep.result?.ts);
        const showIdentity = mode === "execution" || showWorker;
        const label = showIdentity ? workerLabel(entry.worker) : "Agent";
        return (
          <section key={"assistant" + entry.key} className="min-w-0 py-2" aria-label={`${label}回复 ${entry.key}`}>
            {showIdentity && (
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={
                    "flex size-5 shrink-0 items-center justify-center rounded text-white " + workerColor(entry.worker)
                  }
                >
                  <Bot className="size-3" />
                </span>
                <span className="text-xs font-medium">{label}</span>
                {mode === "execution" && timestamp && <ActivityTime ts={timestamp} />}
              </div>
            )}
            <AssistantResponse entry={entry} getDetail={getDetail} live={live} focusedSeq={focusedSeq} />
          </section>
        );
      })}
    </div>
  );
}

// Both contexts share the response layout; execution mode adds worker identity and time.
export function Transcript({
  activity,
  live,
  taskId,
  chat,
  fetchDetail,
  focusedSeq,
  mode,
}: {
  activity: Activity[];
  live?: boolean;
  taskId?: string;
  chat?: boolean;
  fetchDetail?: (seq: number) => Promise<string>;
  focusedSeq?: number;
  mode?: TranscriptMode;
}) {
  const currentStatus = React.useMemo(() => executionLabel(activity, Boolean(live)), [activity, live]);
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  const [focusPadding, setFocusPadding] = React.useState(0);
  React.useLayoutEffect(() => {
    if (focusedSeq == null) {
      setFocusPadding(0);
      return;
    }
    const viewport = transcriptRef.current?.closest('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const measure = () => setFocusPadding(viewport.clientHeight / 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [focusedSeq]);
  return (
    <div
      ref={transcriptRef}
      className="mx-auto flex w-full max-w-3xl flex-col gap-3 leading-normal"
      style={focusPadding ? { paddingBlock: focusPadding } : undefined}
    >
      <ExecView
        activity={activity}
        taskId={taskId}
        mode={mode ?? (chat ? "conversation" : "execution")}
        live={live}
        fetchDetail={fetchDetail}
        focusedSeq={focusedSeq}
      />
      {currentStatus && (
        <div className="flex items-center gap-2 pb-2 pt-1 text-xs text-muted-foreground" role="status">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-foreground/45 motion-safe:animate-pulse"
          />
          {currentStatus}
        </div>
      )}
    </div>
  );
}
