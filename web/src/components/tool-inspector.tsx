"use client";

import * as React from "react";

import { ArrowLeft, Check, Copy, FileText, LoaderCircle, RotateCw, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import {
  buildBoundedDiff,
  type DiffLine,
  fileContentLines,
  hasCompleteSnapshots,
  type InspectorEntry,
  inspectorModel,
  type ReadLine,
  readRecordLines,
} from "@/lib/tool-inspector";
import { formatToolData, type ToolGroup, workspaceRelativePath } from "@/lib/transcript-groups";
import type { Activity, ActivityDetail, WorkspaceFile } from "@/lib/types";

export type ToolInspectorScope = { taskId?: string; conversationId?: number };
type InspectorController = { openTool: (group: ToolGroup) => void };
const InspectorContext = React.createContext<InspectorController | null>(null);

export function useToolInspectorOptional(): InspectorController | null {
  return React.useContext(InspectorContext);
}

export function useToolInspector(): InspectorController {
  const value = useToolInspectorOptional();
  if (!value) throw new Error("ToolInspectorProvider is required");
  return value;
}

type ReadingPosition = { viewport: HTMLElement; anchor?: Element; offset: number; top: number };

function captureReadingPositions(root: HTMLElement | null): ReadingPosition[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? []).map((viewport) => {
    const top = viewport.getBoundingClientRect().top;
    const anchor = Array.from(viewport.querySelectorAll("[data-message-role], [data-tool-row]")).find(
      (node) => node.getBoundingClientRect().bottom > top + 2,
    );
    return { viewport, anchor, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, top: viewport.scrollTop };
  });
}

function restoreReadingPositions(positions: ReadingPosition[]) {
  for (const { viewport, anchor, offset, top } of positions) {
    if (!viewport.isConnected) continue;
    if (anchor?.isConnected)
      viewport.scrollTop += anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset;
    else viewport.scrollTop = top;
  }
}

export function ToolInspectorProvider({
  scope,
  sessionKey,
  children,
}: {
  scope: ToolInspectorScope;
  sessionKey?: string | number;
  children: React.ReactNode;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const conversation = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLElement | null>(null);
  const positions = React.useRef<ReadingPosition[]>([]);
  const readerPositions = React.useRef(new Map<string, number>());
  const detailCache = React.useRef(new Map<string, ActivityDetail>());
  const [group, setGroup] = React.useState<ToolGroup | null>(null);
  const [wide, setWide] = React.useState(false);
  const scopeKey = `${scope.taskId ?? ""}:${scope.conversationId ?? ""}:${sessionKey ?? ""}`;

  React.useEffect(() => {
    const node = root.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width >= 1000;
      setWide((current) => {
        if (current !== next) positions.current = captureReadingPositions(conversation.current);
        return next;
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // A session change dismisses the inspector without moving focus into the old
  // conversation. Inherited activities are authorized through this current scope.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope identity resets inspection state.
  React.useEffect(() => {
    setGroup(null);
    trigger.current = null;
    detailCache.current.clear();
    readerPositions.current.clear();
  }, [scopeKey]);

  const openTool = React.useCallback((next: ToolGroup) => {
    positions.current = captureReadingPositions(conversation.current);
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setGroup(next);
  }, []);

  const restoreFocus = React.useCallback(() => {
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
    });
  }, []);

  const close = React.useCallback(() => {
    positions.current = captureReadingPositions(conversation.current);
    setGroup(null);
    restoreFocus();
  }, [restoreFocus]);

  // Preserve the visible message when a docked panel changes the text width.
  // biome-ignore lint/correctness/useExhaustiveDependencies: panel visibility and mode change conversation width.
  React.useLayoutEffect(() => {
    const current = positions.current;
    restoreReadingPositions(current);
    const frame = requestAnimationFrame(() => restoreReadingPositions(current));
    return () => cancelAnimationFrame(frame);
  }, [wide, !!group]);

  React.useEffect(() => {
    if (!group || !wide) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [group, wide, close]);

  const controller = React.useMemo(() => ({ openTool }), [openTool]);
  const body = group ? (
    <InspectorBody
      key={`${scopeKey}:${group.key}`}
      group={group}
      scope={scope}
      close={close}
      detailCache={detailCache.current}
      positions={readerPositions.current}
    />
  ) : null;
  return (
    <InspectorContext.Provider value={controller}>
      <div ref={root} className="relative flex min-h-0 min-w-0 flex-1" data-tool-inspector-layout>
        <div ref={conversation} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {children}
        </div>
        {group && wide ? (
          <aside
            aria-label="工具文件查看器"
            className="flex h-full min-h-0 w-[440px] shrink-0 flex-col border-l bg-background"
            data-tool-inspector="docked"
          >
            {body}
          </aside>
        ) : null}
        <Sheet
          open={!!group && !wide}
          onOpenChange={(open) => {
            if (!open) close();
          }}
        >
          <SheetContent
            showCloseButton={false}
            aria-describedby={undefined}
            className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[520px]"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!wide) restoreFocus();
            }}
          >
            <SheetTitle className="sr-only">工具文件查看器</SheetTitle>
            <SheetDescription className="sr-only">查看本次工具记录、文件当前内容及真实修改前后差异。</SheetDescription>
            {!wide ? body : null}
          </SheetContent>
        </Sheet>
      </div>
    </InspectorContext.Provider>
  );
}

type DetailState = { group: ToolGroup; loading: boolean; error: string | null };
type View = "record" | "current" | "raw" | "before" | "after";

function InspectorBody({
  group,
  scope,
  close,
  detailCache,
  positions,
}: {
  group: ToolGroup;
  scope: ToolInspectorScope;
  close: () => void;
  detailCache: Map<string, ActivityDetail>;
  positions: Map<string, number>;
}) {
  const [detail, setDetail] = React.useState<DetailState>({ group, loading: true, error: null });
  const [revision, retry] = React.useReducer((value: number) => value + 1, 0);
  const [view, setView] = React.useState<View>("record");
  const [selectedEntry, setSelectedEntry] = React.useState<InspectorEntry | null>(null);
  const [file, setFile] = React.useState<{ key: string; loading: boolean; value?: WorkspaceFile; error?: string }>({
    key: "",
    loading: false,
  });
  const [fileRevision, retryFile] = React.useReducer((value: number) => value + 1, 0);
  const model = React.useMemo(() => inspectorModel(detail.group), [detail.group]);
  const artifact = model.artifact;
  const snapshots = hasCompleteSnapshots(artifact) && !group.result?.is_error;
  const diff = React.useMemo(
    () => (snapshots ? buildBoundedDiff(artifact?.before ?? "", artifact?.after ?? "") : null),
    [snapshots, artifact?.before, artifact?.after],
  );
  const resultSeq = group.result?.seq;
  const filePath = selectedEntry?.path || model.path;
  const hasRecordedTarget = !model.legacy;
  const canPreview =
    hasRecordedTarget &&
    !!filePath &&
    resultSeq !== undefined &&
    (!!scope.taskId || scope.conversationId !== undefined);
  const fileKey = `${scope.taskId ?? ""}:${scope.conversationId ?? ""}:${resultSeq}:${filePath}:${fileRevision}`;
  const scroll = React.useRef<HTMLElement>(null);
  const scrollKey = `${group.key}:${view}:${selectedEntry?.path ?? ""}:${selectedEntry?.line ?? ""}`;
  const highlighted = React.useRef(new Set<string>());

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries failed reads.
  React.useEffect(() => {
    let active = true;
    setDetail({ group, loading: true, error: null });
    const load = async (row?: Activity): Promise<Activity | undefined> => {
      if (!row) return undefined;
      const key = `${scope.taskId ?? ""}:${scope.conversationId ?? ""}:${row.seq}`;
      let record = detailCache.get(key);
      if (!record) {
        if (scope.taskId) record = await api.activityRecordDetail(row.seq, scope.taskId);
        else if (scope.conversationId !== undefined)
          record = await api.conversationMsgRecordDetail(scope.conversationId, row.seq);
        else if (row.detail !== undefined) record = { detail: row.detail, metadata: row.metadata };
        else throw new Error("此会话没有可用的记录来源。");
        detailCache.set(key, record);
      }
      return { ...row, detail: record.detail, metadata: { ...row.metadata, ...record.metadata } };
    };
    void Promise.allSettled([load(group.use), load(group.result)]).then(([use, result]) => {
      if (!active) return;
      const errors = [use, result].filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      setDetail({
        group: {
          ...group,
          use: use.status === "fulfilled" ? use.value : group.use,
          result: result.status === "fulfilled" ? result.value : group.result,
        },
        loading: false,
        error: errors.length ? "完整工具记录加载失败，当前内容可能只是摘要。" : null,
      });
    });
    return () => {
      active = false;
    };
  }, [group, scope.taskId, scope.conversationId, detailCache, revision]);

  React.useEffect(() => {
    if (view !== "current" || !canPreview) return;
    let active = true;
    setFile({ key: fileKey, loading: true });
    void api
      .workspacePreview({
        ...(scope.taskId ? { task: scope.taskId } : { conversation: scope.conversationId }),
        activity_seq: resultSeq,
        // Search entries are backend-recorded paths. For direct reads and edits,
        // the server derives the only permitted target from the activity itself.
        ...(selectedEntry ? { path: selectedEntry.path } : {}),
      })
      .then((value) => {
        if (active) setFile({ key: fileKey, loading: false, value });
      })
      .catch((error: unknown) => {
        if (active)
          setFile({
            key: fileKey,
            loading: false,
            error: error instanceof Error ? error.message : "当前文件读取失败。",
          });
      });
    return () => {
      active = false;
    };
  }, [view, canPreview, fileKey, scope.taskId, scope.conversationId, resultSeq, selectedEntry]);

  React.useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    node.scrollTop = positions.get(scrollKey) ?? 0;
  }, [scrollKey, positions]);

  React.useLayoutEffect(() => {
    const node = scroll.current;
    if (view !== "current" || !selectedEntry?.line || !node || file.loading || file.key !== fileKey) return;
    if (highlighted.current.has(scrollKey)) return;
    const line = node.querySelector<HTMLElement>(`[data-file-line="${selectedEntry.line}"]`);
    if (line) {
      node.scrollTop = line.offsetTop - node.offsetTop - 36;
      highlighted.current.add(scrollKey);
    }
  }, [view, selectedEntry?.line, file.loading, file.key, fileKey, scrollKey]);

  const changeView = (next: View) => {
    if (scroll.current) positions.set(scrollKey, scroll.current.scrollTop);
    setView(next);
  };
  const openEntry = (entry: InspectorEntry) => {
    if (scroll.current) positions.set(scrollKey, scroll.current.scrollTop);
    setSelectedEntry(entry);
    setView("current");
  };
  const back = () => {
    setSelectedEntry(null);
    changeView("record");
  };
  const copyText =
    view === "current"
      ? ((file.key === fileKey ? file.value?.content : "") ?? "")
      : view === "before"
        ? (artifact?.before ?? "")
        : view === "after"
          ? (artifact?.after ?? "")
          : view === "record" && model.kind === "change" && diff?.exact
            ? diff.lines
                .map((row) => `${row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}${row.text}`)
                .join("\n")
            : model.output;
  const copyDisabled =
    view === "current"
      ? !canPreview ||
        file.loading ||
        !!file.error ||
        file.key !== fileKey ||
        file.value?.content === undefined ||
        !!file.value.binary ||
        !!file.value.too_large
      : detail.loading || !!detail.error;
  const label = model.kind === "read" ? "本次读取" : model.kind === "change" ? "本次修改" : "本次结果";
  const tabs: { value: View; label: string; disabled?: boolean }[] = [
    { value: "record", label },
    {
      value: "current",
      label: "当前文件",
      disabled: !canPreview || ((model.kind === "search" || model.kind === "directory") && !selectedEntry),
    },
    ...(snapshots
      ? [
          { value: "before" as const, label: "修改前" },
          { value: "after" as const, label: "修改后" },
        ]
      : []),
    { value: "raw", label: "原始记录" },
  ];
  const activeLabel = tabs.find((tab) => tab.value === view)?.label ?? label;
  const copyLabel =
    view === "raw"
      ? "复制原始输出"
      : view === "record" && model.kind === "change"
        ? diff?.exact
          ? "复制本次修改差异"
          : "复制本次修改结果"
        : `复制${activeLabel}内容`;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground" data-tool-inspector-content>
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3">
        {selectedEntry ? (
          <Button variant="ghost" size="icon-sm" aria-label="返回搜索结果" onClick={back}>
            <ArrowLeft />
          </Button>
        ) : (
          <FileText className="size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1 py-2">
          <div className="truncate text-[13px] font-medium" title={filePath}>
            {workspaceRelativePath(filePath, artifact?.working_dir) || model.name}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {model.kind === "change"
              ? "修改记录"
              : model.kind === "search" || model.kind === "directory"
                ? "搜索与文件"
                : "文件查看器"}{" "}
            · 只读
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={close} aria-label="关闭文件查看器">
          <X />
        </Button>
      </header>
      <fieldset className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1.5" aria-label="查看内容">
        {tabs.map((tab) => (
          <Button
            key={tab.value}
            variant={view === tab.value ? "secondary" : "ghost"}
            size="sm"
            className="text-xs"
            aria-pressed={view === tab.value}
            disabled={tab.disabled}
            onClick={() => changeView(tab.value)}
          >
            {tab.label}
          </Button>
        ))}
      </fieldset>
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3" data-tool-inspector-toolbar>
        <span className="text-xs text-muted-foreground">{activeLabel}</span>
        <CopyButton key={scrollKey} text={copyText} label={copyLabel} disabled={copyDisabled} />
      </div>
      {detail.loading ? (
        <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="size-3.5 animate-spin" />
          正在读取工具记录…
        </div>
      ) : null}
      {detail.error ? (
        <Notice error>
          <span>{detail.error}</span>
          <Button variant="ghost" size="sm" onClick={retry}>
            <RotateCw />
            重试
          </Button>
        </Notice>
      ) : null}
      <section
        ref={scroll}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Read-only file output needs keyboard scrolling.
        tabIndex={0}
        aria-label="文件与修改内容"
        className="relative min-h-0 flex-1 overflow-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-ring"
        onScroll={(event) => positions.set(scrollKey, event.currentTarget.scrollTop)}
        data-tool-inspector-scroll
      >
        {view === "raw" ? (
          <div className="space-y-4 p-3">
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">调用参数</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs leading-5">
                {formatToolData(detail.group.use?.detail ?? detail.group.use?.summary ?? "未记录调用参数")}
              </pre>
            </details>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">
              {formatToolData(model.output) || (group.result ? "工具未返回文字内容。" : "尚未收到工具结果。")}
            </pre>
          </div>
        ) : null}
        {view === "current" ? (
          <>
            <Notice>当前文件可能已被后续操作修改，与本次工具执行时的内容不同。</Notice>
            {file.loading || file.key !== fileKey ? (
              <Loading />
            ) : file.error ? (
              <Notice error>
                <span>{file.error}</span>
                <Button variant="ghost" size="sm" onClick={retryFile}>
                  <RotateCw />
                  重试
                </Button>
              </Notice>
            ) : file.value?.binary ? (
              <Notice>这是二进制文件，无法显示文本内容。</Notice>
            ) : file.value?.too_large ? (
              <Notice>文件较大，当前预览未返回文本内容。</Notice>
            ) : (
              <CodeLines lines={fileContentLines(file.value?.content ?? "")} highlight={selectedEntry?.line} />
            )}
          </>
        ) : null}
        {view === "before" || view === "after" ? (
          <CodeLines lines={fileContentLines(view === "before" ? (artifact?.before ?? "") : (artifact?.after ?? ""))} />
        ) : null}
        {view === "record" && model.kind === "read" ? (
          <>
            {model.legacy && !group.result?.is_error ? (
              <Notice>此历史记录未保存可核验的文件路径，当前展示当时的工具输出。</Notice>
            ) : null}
            {artifact?.truncated || readRecordLines(model.output).truncated ? (
              <Notice>本次读取记录已截断，仅展示实际记录的范围。</Notice>
            ) : null}
            {group.result?.is_error ? <Notice error>本次读取失败，以下为工具返回的错误信息。</Notice> : null}
            <CodeLines lines={readRecordLines(model.output, artifact?.line_start).lines} />
          </>
        ) : null}
        {view === "record" && model.kind === "change" ? (
          <>
            {snapshots && diff?.exact ? (
              <>
                <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-3 py-2 text-xs">
                  <span>本次完整文件差异</span>
                  <span className="text-emerald-700 dark:text-emerald-400">+{diff.added}</span>
                  <span className="text-red-700 dark:text-red-400">−{diff.removed}</span>
                </div>
                {diff.added === 0 && diff.removed === 0 ? (
                  <Notice>修改前后内容相同。</Notice>
                ) : (
                  <DiffLines lines={diff.lines} />
                )}
              </>
            ) : snapshots ? (
              <Notice>{diff?.reason}可切换“修改前”和“修改后”查看完整记录。</Notice>
            ) : (
              <>
                <Notice>未记录完整修改前后内容。{unavailableReason(artifact?.unavailable_reason)}</Notice>
                <RequestedEdits input={model.input} />
                <div className="px-3 pb-3">
                  <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">{model.output}</pre>
                </div>
              </>
            )}
          </>
        ) : null}
        {view === "record" && (model.kind === "search" || model.kind === "directory") ? (
          <>
            <div className="border-b px-3 py-2 text-xs text-muted-foreground">
              {artifact?.query ? (
                <div className="mb-1 break-all font-mono text-foreground">{artifact.query}</div>
              ) : null}
              {model.entries.length} 条已记录结果
            </div>
            {artifact?.truncated ? <Notice>本次结果已截断，列表仅包含已记录的文件。</Notice> : null}
            {model.entries.length ? (
              <SearchEntries entries={model.entries} workingDir={artifact?.working_dir} open={openEntry} disabled={!resultSeq} />
            ) : (
              <div className="p-3">
                <p className="mb-3 text-xs text-muted-foreground">
                  {unavailableReason(artifact?.unavailable_reason) || "没有可可靠定位的文件结果。"}
                  以下保留完整原始记录。
                </p>
                <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">
                  {model.output || "尚无结果"}
                </pre>
              </div>
            )}
          </>
        ) : null}
        {view === "record" && model.kind === "raw" ? (
          <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-5">{model.output}</pre>
        ) : null}
      </section>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground" role="status">
      <LoaderCircle className="size-4 animate-spin" />
      正在读取文件…
    </div>
  );
}

function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs leading-5 ${error ? "text-destructive" : "text-muted-foreground"}`}
      role={error ? "alert" : undefined}
    >
      {children}
    </div>
  );
}

function unavailableReason(reason?: string): string {
  if (!reason) return "";
  switch (reason) {
    case "before_unreadable":
      return "未能读取修改前的文件内容。";
    case "snapshot_too_large":
      return "文件超出快照大小限制，未保存完整修改前后内容。";
    case "binary_or_invalid_utf8":
      return "文件为二进制内容或不是有效 UTF-8 文本。";
    case "path_unavailable":
      return "未能记录文件路径。";
    case "unstructured_search_output":
      return "此次搜索未生成可定位的结构化结果。";
    default:
      return "此记录无法提供完整内容。";
  }
}

function CopyButton({ text, label, disabled }: { text: string; label: string; disabled: boolean }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    if (disabled || !text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("复制失败，请手动选择内容复制");
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="size-7 p-0 text-muted-foreground"
      aria-label={copied ? "已复制" : label}
      title={copied ? "已复制" : label}
      disabled={disabled || !text}
      onClick={() => void copy()}
      data-tool-inspector-copy
    >
      {copied ? <Check className="block size-3.5" /> : <Copy className="block size-3.5" />}
    </Button>
  );
}

function CodeLines({ lines, highlight }: { lines: ReadLine[]; highlight?: number }) {
  if (!lines.length) return <div className="p-4 text-xs text-muted-foreground">文件内容为空。</div>;
  return (
    <section className="min-w-full w-max py-2 font-mono text-xs leading-5" aria-label="只读文件内容">
      {lines.map((line, index) => (
        <div
          key={`${index}:${line.number ?? "raw"}`}
          data-file-line={line.number}
          className={`flex min-h-5 ${line.number === highlight ? "bg-amber-100/70 dark:bg-amber-900/30" : ""}`}
        >
          <span
            className="sticky left-0 w-12 shrink-0 select-none bg-background/95 pr-3 text-right text-muted-foreground/60"
            aria-hidden="true"
          >
            {line.number}
          </span>
          <pre className="m-0 whitespace-pre pr-5">{line.text || " "}</pre>
        </div>
      ))}
    </section>
  );
}

function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <section className="min-w-full w-max py-2 font-mono text-xs leading-5" aria-label="修改前后统一差异">
      {lines.map((row, index) => (
        <div
          key={`${index}:${row.kind}`}
          className={
            row.kind === "add"
              ? "bg-emerald-50 dark:bg-emerald-950/30"
              : row.kind === "remove"
                ? "bg-red-50 dark:bg-red-950/30"
                : ""
          }
        >
          <div className="flex min-h-5">
            <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/60">{row.beforeLine}</span>
            <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground/60">{row.afterLine}</span>
            <span className="w-5 shrink-0 select-none text-center">
              {row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}
            </span>
            <pre className="m-0 whitespace-pre pr-5">{row.text || " "}</pre>
          </div>
          {row.noNewline && row.kind !== "context" ? (
            <div className="pl-25 pr-3 text-[11px] text-muted-foreground">\ 文件末尾无换行符</div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function RequestedEdits({ input }: { input: Record<string, unknown> }) {
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  const fragments = edits.filter(
    (edit): edit is { old_string: string; new_string: string } =>
      !!edit && typeof edit === "object" && typeof edit.old_string === "string" && typeof edit.new_string === "string",
  );
  if (!fragments.length) return null;
  return (
    <div className="space-y-3 p-3">
      <p className="text-xs text-muted-foreground">请求替换片段（调用参数，不代表实际文件差异）</p>
      {fragments.map((edit, index) => (
        <div key={`fragment-${index}`} className="space-y-2 rounded-md border p-2">
          <div className="text-[11px] text-muted-foreground">原片段</div>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">{edit.old_string || "（空）"}</pre>
          <div className="text-[11px] text-muted-foreground">替换片段</div>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">{edit.new_string || "（空）"}</pre>
        </div>
      ))}
    </div>
  );
}

function SearchEntries({
  entries,
  workingDir,
  open,
  disabled,
}: {
  entries: InspectorEntry[];
  workingDir?: string;
  open: (entry: InspectorEntry) => void;
  disabled: boolean;
}) {
  const files = new Map<string, InspectorEntry[]>();
  for (const entry of entries) {
    const matches = files.get(entry.path);
    if (matches) matches.push(entry);
    else files.set(entry.path, [entry]);
  }
  return (
    <div>
      {Array.from(files, ([path, matches]) => (
        <section key={path} aria-label={path} className="border-b py-1">
          <div className="flex items-center gap-2 px-3 py-2 text-xs">
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="break-all font-medium" title={path}>{workspaceRelativePath(path, workingDir)}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">
              {matches.length > 1 ? `${matches.length} 处` : ""}
            </span>
          </div>
          {matches.map((entry, index) => (
            <button
              type="button"
              key={`${entry.line ?? "file"}:${index}`}
              className="flex w-full min-w-0 items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
              onClick={() => open(entry)}
              disabled={disabled}
              aria-label={`查看 ${path}${entry.line ? ` 第 ${entry.line} 行` : ""}`}
            >
              <span className="w-8 shrink-0 text-right font-mono text-muted-foreground">{entry.line ?? "↗"}</span>
              <span className="min-w-0 break-all font-mono">
                {entry.text ?? (entry.count !== undefined ? `${entry.count} 处匹配 · 查看文件` : "查看当前文件")}
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
