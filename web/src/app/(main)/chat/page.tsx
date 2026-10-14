"use client";

import * as React from "react";

import {
  ArrowUpIcon,
  Bot,
  ChevronDownIcon,
  ChevronRightIcon,
  InfoIcon,
  ListChecksIcon,
  Loader2Icon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  Square,
  Trash2Icon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { toast } from "sonner";

import { ApprovalExecutionFocus, useApprovalFocus, useApprovalHistory } from "@/components/approval-execution-focus";
import { ConversationComposer, ConversationComposerToolbar } from "@/components/conversation-composer";
import { ConversationWorkspace, conversationReadingClassName } from "@/components/conversation-workspace";
import { ConversationScrollButton } from "@/components/conversation-scroll-button";
import { MentionTextarea } from "@/components/mention-textarea";
import { ToolInspectorProvider } from "@/components/tool-inspector";
import { SideQuestionButton, SideQuestionWorkspace } from "@/components/side-question-workspace";
import { TodoPopover } from "@/components/todo-popover";
import { Transcript } from "@/components/transcript";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useConversationScroll } from "@/hooks/use-conversation-scroll";
import { useSessionDrafts } from "@/hooks/use-session-drafts";
import { useSideQuestions } from "@/hooks/use-side-questions";
import { mergeActivities } from "@/lib/activity-merge";
import { api } from "@/lib/api";
import { shouldSubmitOnKey, useChatSendMode } from "@/lib/chat-send-mode";
import { getLocalStorageValue, setLocalStorageValue } from "@/lib/local-storage.client";
import { isBtwCommand } from "@/lib/side-questions";
import type { Activity, Agent, ChatAttachment, Conversation, LLMProfile } from "@/lib/types";
import { cn } from "@/lib/utils";

// fmtBytes renders a human file size for attachment chips (mirrors transcript.tsx).
function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

// fmtTokens renders a compact token count (1234 → 1.2k, 2_000_000 → 2M).
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

// fmtDuration renders an elapsed milliseconds span compactly (90s → 1m30s).
function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

// HISTORY_PAGE is how many steps one history page loads: the latest page on open,
// then one more page each time the user scrolls to the top. Kept modest so a long
// thread stays snappy (only ~a page of rows is in the DOM until you scroll up).
const HISTORY_PAGE = 200;
const CONVERSATION_LIST_PAGE = 100;

// Which agent groups the user has collapsed in the left rail. Persisted so the
// rail looks the same after a reload; unknown keys are harmless (a deleted agent
// simply never renders a group again).
const COLLAPSED_AGENTS_KEY = "artex.chat.collapsed-agents";

function conversationIsPinned(conversation: Conversation): boolean {
  return conversation.pinned ?? Boolean(conversation.pinned_at);
}

// AgentGroup is one collapsible section of the left rail: all unpinned
// conversations of a single agent, newest activity first.
interface AgentGroup {
  key: string;
  name: string;
  conversations: Conversation[];
  runningCount: number;
}

// groupByAgent buckets conversations by agent, preserving the incoming order
// both inside a group and across groups. The server already sorts by updated_at
// DESC, so first-appearance order == most-recently-active group first.
function groupByAgent(conversations: Conversation[], agentByKey: Map<string, Agent>): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const conversation of conversations) {
    let group = groups.get(conversation.agent_key);
    if (!group) {
      group = {
        key: conversation.agent_key,
        name: agentByKey.get(conversation.agent_key)?.name || conversation.agent_key,
        conversations: [],
        runningCount: 0,
      };
      groups.set(conversation.agent_key, group);
    }
    group.conversations.push(conversation);
    if (conversation.running) group.runningCount++;
  }
  return [...groups.values()];
}

// LiveBadge names the current run rather than the transport connection.
function LiveBadge() {
  return (
    <span
      role="status"
      className="inline-flex shrink-0 items-center gap-1 rounded bg-blue-500/15 px-1.5 py-0.5 font-medium text-blue-600 text-xs dark:text-blue-400"
    >
      <span className="size-1 animate-pulse rounded-full bg-blue-500" />
      运行中
    </span>
  );
}

// Composer is the shared bottom input (textarea grows to a cap, Enter sends,
// Shift+Enter newlines) — the same affordance across DraftChat and ChatView.
function Composer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  leftSlot,
  running,
  onStop,
  stopDisabled,
  attachments,
  onPickFiles,
  onRemoveAttachment,
  uploading,
  allowBtw,
  recipient,
  footerSlot,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
  leftSlot?: React.ReactNode;
  running?: boolean;
  onStop?: () => void;
  stopDisabled?: boolean;
  // 方式1 文件上传:传了 onPickFiles 才显示回形针按钮 + 附件 chip 预览。
  attachments?: ChatAttachment[];
  onPickFiles?: (files: File[]) => void;
  onRemoveAttachment?: (path: string) => void;
  uploading?: boolean;
  allowBtw?: boolean;
  recipient?: string;
  footerSlot?: React.ReactNode;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const atts = attachments ?? [];
  // 发送键位由系统设置决定（localStorage），默认 Enter 发送。
  const sendMode = useChatSendMode();
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitOnKey(e, sendMode)) return;
    e.preventDefault();
    onSend();
  }
  return (
    <ConversationComposer>
      {atts.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {atts.map((a) => (
            <div
              key={a.path}
              className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs"
              title={a.path}
            >
              <PaperclipIcon className="size-3 shrink-0 text-primary" />
              <span className="max-w-[160px] truncate">{a.name}</span>
              <span className="shrink-0 text-muted-foreground">{fmtBytes(a.size)}</span>
              {onRemoveAttachment && (
                <button
                  type="button"
                  className="ml-0.5 text-muted-foreground hover:text-foreground"
                  onClick={() => onRemoveAttachment(a.path)}
                  aria-label={`移除附件 ${a.name}`}
                  title="移除"
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <MentionTextarea
        className="max-h-40 min-h-16 w-full resize-none border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
        rows={2}
        aria-label="消息内容"
        placeholder={placeholder}
        value={value}
        disabled={disabled && !(running && allowBtw)}
        onValueChange={onChange}
        onKeyDown={onKeyDown}
      />
      <ConversationComposerToolbar>
        {onPickFiles && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                // FileList 与 input 元素活绑定:必须先快照成数组,再清空 value,
                // 否则异步的 onPickFiles(比如草稿态要先建会话)恢复执行时会拿到空列表。
                const picked = Array.from(e.target.files ?? []);
                e.target.value = ""; // allow re-picking the same file
                if (picked.length > 0) onPickFiles(picked);
              }}
            />
            <Button
              size="icon-sm"
              className="rounded-full"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || uploading}
              aria-label="上传文件"
              title="上传文件"
            >
              {uploading ? <Loader2Icon className="size-4 animate-spin" /> : <PaperclipIcon className="size-4" />}
            </Button>
          </>
        )}
        <div className="min-w-0 flex-1">
          {leftSlot}
          {recipient && <p className="truncate text-xs text-muted-foreground">发送给 {recipient}</p>}
          {footerSlot}
        </div>
        {running && allowBtw && isBtwCommand(value) && (
          <Button
            size="icon-sm"
            className="rounded-full"
            onClick={onSend}
            aria-label="发送旁路问题"
            title="发送旁路问题"
          >
            <ArrowUpIcon />
          </Button>
        )}
        {running ? (
          // while a run is in flight the send button becomes a stop button —
          // aborts just this session (the trigger queue keeps going).
          <Button
            size="icon-sm"
            className="rounded-full"
            variant="secondary"
            onClick={onStop}
            disabled={stopDisabled}
            aria-label="停止本次运行"
            title="停止本次运行"
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            size="icon-sm"
            className="rounded-full"
            onClick={onSend}
            disabled={disabled || (!value.trim() && atts.length === 0)}
            title="发送消息"
            aria-label="发送消息"
          >
            <ArrowUpIcon />
          </Button>
        )}
      </ConversationComposerToolbar>
    </ConversationComposer>
  );
}

// LLMProfileRow shows the active LLM config inside the composer and lets the user
// switch it via a Popover. `selected` is the profile id or null for default.
function LLMProfileRow({
  profiles,
  selected,
  onChange,
  disabled,
  rightSlot,
}: {
  profiles: LLMProfile[];
  selected: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
  rightSlot?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const activeDefault = profiles.find((p) => p.is_default);
  const current = selected != null ? profiles.find((p) => Number(p.id) === selected) : null;
  const label = current ? current.name : `默认${activeDefault ? `（${activeDefault.name}）` : ""}`;

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="flex min-w-0 items-center gap-1 rounded-md px-1 py-1 text-muted-foreground text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
            aria-label={`更换 LLM 配置，当前：${label}`}
            title={label}
          >
            <ZapIcon className="size-3 shrink-0" />
            <span className="truncate">{label}</span>
            <ChevronDownIcon className="size-3 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <p className="text-muted-foreground px-2 py-1 text-xs font-medium">选择 LLM 配置</p>
          {/* default option */}
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={cn(
              "group/model flex w-full flex-col rounded px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected == null && "bg-accent text-accent-foreground",
            )}
          >
            <span className="text-sm">默认{activeDefault ? `（${activeDefault.name}）` : ""}</span>
            {activeDefault && (
              <span
                className={cn(
                  "text-xs group-hover/model:text-accent-foreground",
                  selected == null ? "text-accent-foreground" : "text-muted-foreground",
                )}
              >
                {activeDefault.format} · {activeDefault.model}
              </span>
            )}
          </button>
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onChange(Number(p.id));
                setOpen(false);
              }}
              className={cn(
                "group/model flex w-full flex-col rounded px-2 py-2 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected === Number(p.id) && "bg-accent text-accent-foreground",
              )}
            >
              <span className="text-sm">{p.name}</span>
              <span
                className={cn(
                  "text-xs group-hover/model:text-accent-foreground",
                  selected === Number(p.id) ? "text-accent-foreground" : "text-muted-foreground",
                )}
              >
                {p.format} · {p.model}
              </span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
      {rightSlot}
    </div>
  );
}

// DraftChat is the default right-pane view: a fresh chat (agent picker in the
// header, centered empty state, composer) with NO conversation created yet. The
// conversation is created lazily on the first send (ChatGPT-style), then the
// parent switches to the real ChatView.
function DraftChat({
  agents,
  profiles,
  onStarted,
}: {
  agents: Agent[];
  profiles: LLMProfile[];
  onStarted: (c: Conversation, pending?: { input?: string; attachments?: ChatAttachment[] }) => void;
}) {
  const [agentKey, setAgentKey] = React.useState("");
  const [llmProfileId, setLlmProfileId] = React.useState<number | null>(null);
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);

  // default the agent to Auto once agents load.
  React.useEffect(() => {
    if (!agentKey && agents.some((a) => a.key === "auto")) setAgentKey("auto");
  }, [agentKey, agents]);

  const agent = agents.find((a) => a.key === agentKey);

  async function send() {
    const msg = input.trim();
    if (!msg || !agentKey || sending) return;
    setSending(true);
    try {
      const c = await api.createConversation(agentKey, "", llmProfileId);
      await api.sendConversationMessage(c.id, msg);
      onStarted(c);
    } catch (e) {
      toast.error("发送失败：" + (e as Error).message);
      setSending(false);
    }
  }

  // Attachments need a conversation to own the uploads dir (sessions/conv-<id>/),
  // and a draft has none yet — so picking a file CREATES the conversation, uploads
  // into it, then hands off to ChatView carrying the typed text + attachments (the
  // user sends from there). Mirrors the task main-agent console's upload, adapted to
  // the ChatGPT-style lazy-create flow.
  async function pickFiles(files: File[]) {
    if (files.length === 0 || !agentKey || uploading || sending) return;
    setUploading(true);
    try {
      const c = await api.createConversation(agentKey, "", llmProfileId);
      const r = await api.chatUpload("session", `conv-${c.id}`, files);
      onStarted(c, { input, attachments: r.attachments });
    } catch (e) {
      toast.error("上传失败：" + (e as Error).message);
      setUploading(false);
    }
  }

  const agentPicker = (
    <Select value={agentKey} onValueChange={setAgentKey}>
      <SelectTrigger
        size="sm"
        className="h-6 w-fit max-w-full gap-1 border-0 bg-transparent px-1 shadow-none dark:bg-transparent"
        aria-label="选择对话 Agent"
      >
        <SelectValue placeholder="选择 Agent…" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {agents.map((a) => (
            <SelectItem key={a.key} value={a.key}>
              <span className="flex items-center gap-2">
                <Bot className="size-3.5" />
                {a.name}
                {!a.builtin && (
                  <Badge variant="outline" className="px-1 py-0 text-[9px]">
                    自定义
                  </Badge>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );

  return (
    <>
      <div className="shrink-0 border-b px-4 py-3">
        <h1 className="text-sm font-semibold">新对话</h1>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{agent?.name ?? "选择 Agent"}</p>
      </div>
      {/* empty / landing state fills the panel */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <div className="bg-primary/10 flex size-12 items-center justify-center rounded-full">
          <Bot className="text-primary size-6" />
        </div>
        <div className="text-base font-medium">开始和「{agent?.name ?? "Agent"}」对话</div>
        {agent?.description && (
          <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">{agent.description}</p>
        )}
      </div>

      <Composer
        value={input}
        onChange={setInput}
        onSend={send}
        disabled={sending || uploading || !agentKey}
        placeholder="描述你想完成的事情，@ 引用已有记录…"
        leftSlot={agentPicker}
        onPickFiles={pickFiles}
        uploading={uploading}
        footerSlot={
          <LLMProfileRow
            profiles={profiles}
            selected={llmProfileId}
            onChange={setLlmProfileId}
            disabled={sending || uploading}
          />
        }
      />
    </>
  );
}

// ChatView is the right pane for one conversation — mirrors the task detail's
// main-agent console: header with agent + live badge + token/duration meta, a
// scroll-stick transcript (chat mode), and the composer.
function ChatView({
  conv,
  agents,
  profiles,
  drafts,
  onTitleMaybeChanged,
  onConvUpdated,
}: {
  conv: Conversation;
  agents: Agent[];
  profiles: LLMProfile[];
  drafts: ReturnType<typeof useSessionDrafts>;
  onTitleMaybeChanged: () => void;
  onConvUpdated: () => void;
}) {
  const approvalFocus = useApprovalFocus({ conversationId: conv.id });
  const [messages, setMessages] = React.useState<Activity[]>([]);
  const [running, setRunning] = React.useState(false);
  const draftKey = `conversation:${conv.id}`;
  const draft = drafts.getDraft(draftKey);
  const input = draft.text;
  const setInput = (text: string) => drafts.updateDraft(draftKey, { text });
  const sending = !!draft.sending;
  const setSending = (value: boolean) => drafts.updateDraft(draftKey, { sending: value });
  const [stopping, setStopping] = React.useState(false);
  // 方式1 文件上传:已上传的附件(落到 sessions/conv-<id>/uploads/),随下条消息一起发。
  const attachments = draft.attachments;
  const setAttachments = (update: React.SetStateAction<ChatAttachment[]>) => {
    drafts.updateDraft(draftKey, (current) => ({
      attachments: typeof update === "function" ? update(current.attachments) : update,
    }));
  };
  const uploading = !!draft.uploading;
  const setUploading = (value: boolean) => drafts.updateDraft(draftKey, { uploading: value });
  const cursorRef = React.useRef(0); // newest loaded id — incremental-tail anchor
  const earliestRef = React.useRef(0); // earliest loaded id — reverse-pagination anchor
  const hasMoreRef = React.useRef(false); // older history remains above the loaded window
  const loadingMoreRef = React.useRef(false); // guard: one scroll-up load at a time
  const [historyLoaded, setHistoryLoaded] = React.useState(false);
  const [historyError, setHistoryError] = React.useState(false);
  const [historyRevision, setHistoryRevision] = React.useState(0);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false); // drives the "load earlier" hint
  const agent = agents.find((a) => a.key === conv.agent_key);
  const currentProfileId = conv.llm_profile_id ?? null;
  const side = useSideQuestions(`/api/conversations/${conv.id}`);

  async function changeProfile(id: number | null) {
    try {
      await api.updateConversationProfile(conv.id, id);
      onConvUpdated();
    } catch (e) {
      toast.error("切换 LLM 失败：" + (e as Error).message);
    }
  }

  // conversation-scoped detail fetcher for the reused Transcript renderer.
  const fetchDetail = React.useCallback((seq: number) => api.conversationMsgDetail(conv.id, seq), [conv.id]);

  // seq of the most-recent TodoWrite tool call (for the Todo popover); null if none.
  const latestTodoSeq = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const a = messages[i];
      if (a.kind === "tool_use" && a.tool === "TodoWrite") return a.seq;
    }
    return null;
  }, [messages]);

  // reset + load whenever the selected conversation changes. Load only the LATEST
  // page on open — a long thread's final answer sits at the very end, so the newest
  // page shows it immediately (issue #3: opening/refresh used to load the oldest
  // page, so the completed result was missing until another message advanced the
  // cursor). Older history streams in on scroll-up (loadEarlier below).
  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry reloads history for the same conversation.
  React.useEffect(() => {
    cursorRef.current = 0;
    earliestRef.current = 0;
    hasMoreRef.current = false;
    setHasMore(false);
    setMessages([]);
    setHistoryLoaded(false);
    setHistoryError(false);
    setRunning(false);
    let live = true;
    api
      .conversationHistory(conv.id, 0, HISTORY_PAGE)
      .then((r) => {
        if (!live) return;
        setMessages((current) => mergeActivities(r.items, current));
        cursorRef.current = Math.max(cursorRef.current, r.cursor);
        earliestRef.current = r.items.length ? r.items[0].seq : 0;
        hasMoreRef.current = r.hasMore;
        setHasMore(r.hasMore);
        setRunning((current) => current || r.running);
        setHistoryLoaded(true);
      })
      .catch(() => {
        if (live) {
          setHistoryLoaded(true);
          setHistoryError(true);
        }
      });
    return () => {
      live = false;
    };
  }, [conv.id, historyRevision]);

  // A trigger or another tab may start a turn while this conversation is open.
  // A false list snapshot must not stop the tail before its final messages load.
  React.useEffect(() => {
    if (conv.running) setRunning(true);
  }, [conv.running]);

  // poll while a turn is running: pull new steps after the cursor.
  React.useEffect(() => {
    if (!running) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let keepPolling = true;
      try {
        const r = await api.conversationMessages(conv.id, cursorRef.current);
        if (!live) return;
        if (r.items.length) {
          setMessages((prev) => mergeActivities(prev, r.items));
        }
        cursorRef.current = Math.max(cursorRef.current, r.cursor);
        keepPolling = r.running;
        setRunning(r.running);
        if (!r.running) onTitleMaybeChanged(); // first-turn auto-title landed
      } catch {
        /* transient — keep polling */
      } finally {
        // Slow responses must not overlap another poll with the same cursor.
        if (live && keepPolling) timer = setTimeout(() => void tick(), 1000);
      }
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [running, conv.id, onTitleMaybeChanged]);

  const loadFocusPage = React.useCallback(
    (before: number) => api.conversationHistory(conv.id, before, HISTORY_PAGE),
    [conv.id],
  );
  const mergeFocusPage = React.useCallback((page: { items: Activity[]; hasMore: boolean }) => {
    setMessages((prev) => mergeActivities(page.items, prev));
    earliestRef.current = page.items[0]?.seq ?? earliestRef.current;
    hasMoreRef.current = page.hasMore;
    setHasMore(page.hasMore);
  }, []);
  const focusHistory = useApprovalHistory(
    approvalFocus.state?.source,
    historyLoaded,
    messages,
    loadFocusPage,
    mergeFocusPage,
  );

  // ---- transcript auto-scroll (open → bottom; stick to bottom unless scrolled up) ----
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const atBottomRef = React.useRef(true);
  const viewport = React.useCallback(
    () => (contentRef.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null) ?? null,
    [],
  );
  // Scroll-up loads one older page and prepends it, preserving the visual position
  // so the view doesn't jump (record height/offset before, restore the delta after).
  const loadEarlier = React.useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    const vp = viewport();
    if (!vp) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const r = await api.conversationHistory(conv.id, earliestRef.current, HISTORY_PAGE);
      // Read at response time: the reader may move or expand a record while waiting.
      const prevH = vp.scrollHeight;
      const prevTop = vp.scrollTop;
      if (r.items.length) {
        setMessages((prev) => mergeActivities(r.items, prev));
        earliestRef.current = r.items[0].seq;
      }
      hasMoreRef.current = r.hasMore;
      setHasMore(r.hasMore);
      requestAnimationFrame(() => {
        const v = viewport();
        if (v && !atBottomRef.current) v.scrollTop = prevTop + (v.scrollHeight - prevH);
      });
    } catch {
      /* transient — a later scroll retries */
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [conv.id, viewport]);
  const onReachTop = React.useCallback(() => void loadEarlier(), [loadEarlier]);
  const conversationScroll = useConversationScroll({
    contentRef,
    atBottomRef,
    viewport,
    sessionKey: conv.id,
    activity: messages,
    latestSeq: messages.findLast((message) => message.kind !== "usage")?.seq ?? 0,
    paused: !!approvalFocus.state,
    blockHistory: !!approvalFocus.state && !focusHistory.ready,
    onReachTop,
  });

  // Per-conversation token total, live — same accounting as the main-agent
  // console: completed runs' `result` sum + the in-progress run's latest `usage`.
  const tokenTotal = React.useMemo(() => {
    let i = 0,
      o = 0,
      cr = 0;
    let li = 0,
      lo = 0,
      lcr = 0;
    let turns = 0; // agent 循环轮次 = 模型调用次数（每次一条 kind='usage'）
    for (const a of messages) {
      if (a.kind === "result") {
        i += a.input_tokens ?? 0;
        o += a.output_tokens ?? 0;
        cr += a.cache_read_tokens ?? 0;
        li = lo = lcr = 0;
      } else if (a.kind === "usage") {
        turns += 1;
        li = a.input_tokens ?? 0;
        lo = a.output_tokens ?? 0;
        lcr = a.cache_read_tokens ?? 0;
      }
    }
    const I = i + li,
      O = o + lo,
      CR = cr + lcr;
    return { i: I, o: O, cr: CR, turns, any: I + O + CR > 0 };
  }, [messages]);

  // pickFiles uploads into this conversation's session dir (sessions/conv-<id>/
  // uploads/) and queues the returned metadata to send with the next message.
  async function pickFiles(files: File[]) {
    if (files.length === 0 || drafts.getDraft(draftKey).uploading) return;
    setUploading(true);
    try {
      const r = await api.chatUpload("session", `conv-${conv.id}`, files);
      setAttachments((prev) => [...prev, ...r.attachments]);
    } catch (e) {
      toast.error("上传失败：" + (e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    const msg = input.trim();
    const atts = attachments;
    if (side.handleCommand(msg, () => setInput(""))) return;
    const current = drafts.getDraft(draftKey);
    if ((!msg && atts.length === 0) || current.sending || running || current.uploading) return;
    setSending(true);
    setInput("");
    setAttachments([]);
    try {
      await api.sendConversationMessage(conv.id, msg, atts.length ? atts : undefined);
      // The live loop pulls the persisted human turn immediately. Refreshing the
      // parent also reaches a view reopened while this request was in flight.
      setRunning(true);
      onConvUpdated();
    } catch (e) {
      toast.error("发送失败：" + (e as Error).message);
      // Restore to the original recipient, keeping anything written after the
      // user switched away and reopened this conversation during the request.
      drafts.updateDraft(draftKey, (current) => ({
        text: current.text ? `${msg}\n\n${current.text}` : msg,
        attachments: [...atts, ...current.attachments.filter((item) => !atts.some((sent) => sent.path === item.path))],
      }));
    } finally {
      setSending(false);
    }
  }

  // stop aborts the in-flight run for this conversation. running flips to false on
  // the next 1s poll once the backend unwinds the agent; the trigger queue is not
  // affected — the agent's next queued fire still starts.
  async function stop() {
    if (stopping) return;
    setStopping(true);
    try {
      await api.stopConversation(conv.id);
    } catch (e) {
      toast.error("停止失败：" + (e as Error).message);
    } finally {
      setStopping(false);
    }
  }

  return (
    <ToolInspectorProvider scope={{ conversationId: conv.id }}>
      <SideQuestionWorkspace side={side} label={agent?.name ?? conv.agent_key} composerLayout="inline">
        <div className="flex min-w-0 items-center gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-sm font-semibold" title={conv.title || "新对话"}>
                {conv.title || "新对话"}
              </h1>
              {running && <LiveBadge />}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{agent?.name ?? conv.agent_key}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <SideQuestionButton side={side} />
            <Popover>
              <PopoverTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="查看会话详情" title="会话详情">
                  <InfoIcon />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-4">
                <p className="font-medium">会话详情</p>
                {agent?.description && <p className="text-muted-foreground text-xs">{agent.description}</p>}
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">Agent</dt>
                  <dd className="break-all">
                    {conv.agent_key}
                    {agent && !agent.builtin ? "（自定义）" : ""}
                  </dd>
                  <dt className="text-muted-foreground">模型调用</dt>
                  <dd>{tokenTotal.turns} 轮</dd>
                  <dt className="text-muted-foreground">输入 Token</dt>
                  <dd>{fmtTokens(tokenTotal.i)}</dd>
                  <dt className="text-muted-foreground">缓存读取</dt>
                  <dd>{fmtTokens(tokenTotal.cr)}</dd>
                  <dt className="text-muted-foreground">输出 Token</dt>
                  <dd>{fmtTokens(tokenTotal.o)}</dd>
                </dl>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <ApprovalExecutionFocus focus={approvalFocus} history={focusHistory} />

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <ScrollArea type="auto" className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
            <div className={conversationReadingClassName} ref={contentRef}>
              {!historyLoaded && messages.length === 0 ? (
                <div
                  role="status"
                  className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
                >
                  <Spinner className="size-4" />
                  正在加载会话…
                </div>
              ) : historyError && messages.length === 0 ? (
                <div role="alert" className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
                  无法加载会话记录
                  <Button variant="outline" size="sm" onClick={() => setHistoryRevision((value) => value + 1)}>
                    重试加载
                  </Button>
                </div>
              ) : messages.length === 0 && !running ? (
                <div className="text-muted-foreground py-10 text-center text-sm">
                  开始和「{agent?.name ?? conv.agent_key}」对话
                </div>
              ) : (
                <>
                  {hasMore && (
                    <div className="flex justify-center pb-3">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={loadingMore}
                        onClick={() => {
                          conversationScroll.holdPosition();
                          void loadEarlier();
                        }}
                      >
                        {loadingMore && <Spinner className="size-3" aria-hidden="true" />}
                        {loadingMore ? "正在加载更早消息…" : "加载更早消息"}
                      </Button>
                    </div>
                  )}
                  <Transcript
                    activity={messages}
                    live={running}
                    chat
                    mode="conversation"
                    fetchDetail={fetchDetail}
                    focusedSeq={focusHistory.ready ? approvalFocus.state?.source?.seq : undefined}
                  />
                </>
              )}
            </div>
          </ScrollArea>
          {!conversationScroll.isAtBottom && (
            <ConversationScrollButton
              hasNewActivity={conversationScroll.hasNewActivity}
              onClick={() => {
                approvalFocus.close();
                requestAnimationFrame(conversationScroll.jumpToLatest);
              }}
            />
          )}
        </div>

        <Composer
          value={input}
          onChange={setInput}
          onSend={send}
          disabled={running || sending || uploading}
          allowBtw
          placeholder={running ? "Agent 正在执行，可输入 /btw 旁路提问…" : "继续提问或补充要求，@ 引用已有记录…"}
          recipient={agent?.name ?? conv.agent_key}
          running={running}
          onStop={stop}
          stopDisabled={stopping}
          attachments={attachments}
          onPickFiles={pickFiles}
          onRemoveAttachment={(path) => setAttachments((p) => p.filter((x) => x.path !== path))}
          uploading={uploading}
          footerSlot={
            <LLMProfileRow
              profiles={profiles}
              selected={currentProfileId}
              onChange={changeProfile}
              disabled={running || sending}
              rightSlot={<TodoPopover seq={latestTodoSeq} fetchDetail={fetchDetail} />}
            />
          }
        />
      </SideQuestionWorkspace>
    </ToolInspectorProvider>
  );
}

// ConversationItem is one row in the left rail: title, agent subtitle, inline
// rename, pin marker, and a compact action menu. Rows nested under an agent
// group drop the agent subtitle (showAgent=false) — the header already says it.
const ConversationItem = React.memo(function ConversationItem({
  conv,
  agent,
  showAgent = true,
  active,
  renaming,
  renameText,
  onSelect,
  onStartRename,
  onRenameText,
  onCommitRename,
  onCancelRename,
  onTogglePinned,
  onDelete,
  selectionMode,
  selectedForDelete,
  onSelectedForDeleteChange,
}: {
  conv: Conversation;
  agent?: Agent;
  showAgent?: boolean;
  active: boolean;
  renaming: boolean;
  renameText: string;
  onSelect: (id: number) => void;
  onStartRename: (conversation: Conversation) => void;
  onRenameText: (v: string) => void;
  onCommitRename: (id: number, title: string) => void;
  onCancelRename: () => void;
  onTogglePinned: (conversation: Conversation) => void;
  onDelete: (id: number) => void;
  selectionMode: boolean;
  selectedForDelete: boolean;
  onSelectedForDeleteChange: (id: number, checked: boolean) => void;
}) {
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const cancelRenameRef = React.useRef(false);
  const pinned = conversationIsPinned(conv);

  React.useEffect(() => {
    if (!renaming) return;
    cancelRenameRef.current = false;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

  return (
    <div
      className={cn(
        "group flex min-w-0 items-center gap-1 rounded-md pr-1 transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted",
      )}
    >
      {selectionMode && (
        <Checkbox
          checked={selectedForDelete}
          onCheckedChange={(checked) => onSelectedForDeleteChange(conv.id, checked === true)}
          aria-label={`选择对话「${conv.title || "新对话"}」`}
          className="ml-1 shrink-0"
        />
      )}
      {renaming ? (
        <input
          ref={renameInputRef}
          value={renameText}
          onChange={(e) => onRenameText(e.target.value)}
          onBlur={() => {
            if (!cancelRenameRef.current) onCommitRename(conv.id, renameText);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename(conv.id, renameText);
            if (e.key === "Escape") {
              e.preventDefault();
              cancelRenameRef.current = true;
              onCancelRename();
            }
          }}
          className="border-input bg-background min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={() => onSelect(conv.id)}
          onDoubleClick={() => onStartRename(conv)}
          title="双击重命名"
          className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            {pinned && <PinIcon className="text-primary size-3 shrink-0" aria-label="已置顶" />}
            <div className="truncate text-sm">{conv.title || "新对话"}</div>
            {conv.running ? (
              <Badge variant="secondary" className="shrink-0 gap-1" title="Agent 正在运行">
                <Spinner className="size-3" aria-hidden="true" />
                运行中
              </Badge>
            ) : null}
          </div>
          <div
            className={cn(
              "flex min-w-0 items-center gap-1 text-xs",
              active ? "text-accent-foreground" : "text-muted-foreground",
            )}
          >
            {showAgent && (
              <>
                <Bot className="size-3 shrink-0" />
                <span className="min-w-0 truncate">{agent?.name ?? conv.agent_key}</span>
                <span className="shrink-0">·</span>
              </>
            )}
            <span className="shrink-0">
              {new Date(conv.created_at).toLocaleDateString("zh-CN", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <span className="shrink-0">#{conv.id}</span>
          </div>
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn("shrink-0", active ? "text-accent-foreground" : "text-muted-foreground")}
            aria-label={`管理对话「${conv.title || "新对话"}」`}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => onStartRename(conv)}>
              <PencilIcon />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onTogglePinned(conv)}>
              {pinned ? <PinOffIcon /> : <PinIcon />}
              {pinned ? "取消置顶" : "置顶"}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              <Trash2Icon />
              删除
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除对话「{conv.title || "新对话"}」？</AlertDialogTitle>
            <AlertDialogDescription>此操作不可撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => onDelete(conv.id)}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});

// AgentGroupHeader is the sticky, clickable divider above one agent's rows:
// collapse chevron, agent name, a running marker, and the row count.
function AgentGroupHeader({
  group,
  collapsed,
  hasActive,
  onToggle,
}: {
  group: AgentGroup;
  collapsed: boolean;
  hasActive: boolean;
  onToggle: (key: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(group.key)}
      aria-expanded={!collapsed}
      title={collapsed ? `展开「${group.name}」` : `收起「${group.name}」`}
      className={cn(
        "sticky top-0 z-10 flex min-w-0 items-center gap-1.5 rounded-md bg-card px-1.5 py-1 text-left font-medium text-xs transition-colors hover:bg-muted",
        collapsed && hasActive ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", !collapsed && "rotate-90")} />
      <Bot className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{group.name}</span>
      {collapsed && hasActive && (
        <span className="size-1.5 shrink-0 rounded-full bg-primary" title="当前对话在此分组内" />
      )}
      {group.runningCount > 0 && (
        <Spinner className="size-3 shrink-0" aria-label={`${group.runningCount} 个对话运行中`} />
      )}
      <span className="shrink-0 tabular-nums opacity-60">{group.conversations.length}</span>
    </button>
  );
}

export default function ChatPage() {
  const drafts = useSessionDrafts();
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]);
  const [convs, setConvs] = React.useState<Conversation[]>([]);
  const [agentFilter, setAgentFilter] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [listOpen, setListOpen] = React.useState(false);
  const [sourceRequested, setSourceRequested] = React.useState(false);
  const [convsLoaded, setConvsLoaded] = React.useState(false);
  const selectConversation = React.useCallback(
    (id: number | null) => {
      if (id !== selectedId) {
        const url = new URL(window.location.href);
        url.searchParams.delete("approval");
        setSourceRequested(false);
        window.history.replaceState(null, "", url);
      }
      setSelectedId(id);
      setListOpen(false);
    },
    [selectedId],
  );

  const [renamingId, setRenamingId] = React.useState<number | null>(null);
  const [renameText, setRenameText] = React.useState("");
  const [selectedConversationIds, setSelectedConversationIds] = React.useState<Set<number>>(() => new Set());
  // selectionMode gates the multi-select UI: off by default (clean list, no
  // checkboxes); the header "多选" button turns it on, "完成" turns it off and
  // clears the selection.
  const [selectionMode, setSelectionMode] = React.useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const [bulkDeleting, setBulkDeleting] = React.useState(false);
  const [visibleConversationCount, setVisibleConversationCount] = React.useState(CONVERSATION_LIST_PAGE);
  // Collapsed agent groups. Hydrated from localStorage after mount (not a lazy
  // useState init) so the server and client render the same first pass.
  const [collapsedAgents, setCollapsedAgents] = React.useState<Set<string>>(() => new Set());

  const conversationListSeq = React.useRef(0);
  const reloadConvs = React.useCallback(async () => {
    const seq = ++conversationListSeq.current;
    try {
      const items = await api.conversations();
      if (seq === conversationListSeq.current) {
        setConvs(items);
        setConvsLoaded(true);
      }
    } catch {
      // Preserve the selected transcript and list on a transient poll failure.
    }
  }, []);
  React.useEffect(() => {
    api
      .agents()
      .then(setAgents)
      .catch(() => {
        /* Agent metadata is optional for rendering an existing conversation. */
      });
    api
      .llmProfiles()
      .then(setProfiles)
      .catch(() => {
        /* The conversation remains usable without profile labels. */
      });
  }, []);

  // One list poll supplies runtime state for all sidebar rows, including the
  // unselected ones. Await completion so slow requests do not overlap.
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await reloadConvs();
      if (!disposed) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      disposed = true;
      conversationListSeq.current++;
      clearTimeout(timer);
    };
  }, [reloadConvs]);

  React.useEffect(() => {
    setSelectedConversationIds((current) => {
      if (current.size === 0) return current;
      const live = new Set(convs.map((conversation) => conversation.id));
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [convs]);

  React.useEffect(() => {
    const raw = getLocalStorageValue(COLLAPSED_AGENTS_KEY);
    if (!raw) return;
    try {
      const keys = JSON.parse(raw);
      if (Array.isArray(keys))
        setCollapsedAgents(new Set(keys.filter((key): key is string => typeof key === "string")));
    } catch {
      // Corrupted entry → start with everything expanded.
    }
  }, []);

  const toggleAgentCollapsed = React.useCallback((key: string) => {
    setCollapsedAgents((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      setLocalStorageValue(COLLAPSED_AGENTS_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Restore the open conversation from the URL (?c=<id>) on mount, so a refresh
  // returns to the same thread instead of the empty draft view. Runs after
  // hydration (not a lazy useState init) to avoid a server/client mismatch.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSourceRequested(params.has("approval"));
    const c = params.get("c");
    const id = c ? Number(c) : NaN;
    if (Number.isFinite(id)) setSelectedId(id);
  }, []);
  // Mirror the current selection into the URL (replaceState → no history spam). A
  // selectedId with no matching conversation (e.g. a stale ?c=, or a just-created
  // one before reloadConvs lands) simply renders the draft view — harmless — so we
  // deliberately do NOT auto-clear it here (that raced new-conversation creation).
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId != null) url.searchParams.set("c", String(selectedId));
    else url.searchParams.delete("c");
    window.history.replaceState(null, "", url);
  }, [selectedId]);

  const selected = React.useMemo(() => convs.find((c) => c.id === selectedId) ?? null, [convs, selectedId]);
  const agentByKey = React.useMemo(() => new Map(agents.map((agent) => [agent.key, agent])), [agents]);
  const filteredConversations = React.useMemo(
    () => (agentFilter === null ? convs : convs.filter((conversation) => conversation.agent_key === agentFilter)),
    [convs, agentFilter],
  );
  const visibleConversations = React.useMemo(
    () => filteredConversations.slice(0, visibleConversationCount),
    [filteredConversations, visibleConversationCount],
  );
  // Pinned rows stay a flat block above the groups (server order = pinned_at DESC);
  // everything else is bucketed per agent, most-recently-active agent first.
  const pinnedConversations = React.useMemo(
    () => visibleConversations.filter(conversationIsPinned),
    [visibleConversations],
  );
  const agentGroups = React.useMemo(
    () =>
      groupByAgent(
        visibleConversations.filter((c) => !conversationIsPinned(c)),
        agentByKey,
      ),
    [visibleConversations, agentByKey],
  );
  // conversation agents: custom agents + conversational built-ins (role=assistant,
  // e.g. Auto / 渗透测试). The orchestration built-ins (goals/planner/mainagent/worker)
  // are task-specific and stay hidden from the chat page.
  const chatAgents = React.useMemo(() => agents.filter((a) => !a.builtin || a.role === "assistant"), [agents]);
  const agentFilterOptions = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const conversation of convs) {
      counts.set(conversation.agent_key, (counts.get(conversation.agent_key) ?? 0) + 1);
    }
    // Include historical sources even if their Agent has since been disabled or deleted.
    const keys = new Set([...chatAgents.map((agent) => agent.key), ...counts.keys()]);
    if (agentFilter !== null) keys.add(agentFilter);
    return [...keys]
      .map((key) => ({ key, name: agentByKey.get(key)?.name || key, count: counts.get(key) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [convs, chatAgents, agentByKey, agentFilter]);
  const conversationCountLabel =
    agentFilter === null ? `共 ${convs.length} 个` : `${filteredConversations.length} / ${convs.length} 个`;

  function changeAgentFilter(key: string | null) {
    setAgentFilter(key);
    setVisibleConversationCount(CONVERSATION_LIST_PAGE);
    setSelectedConversationIds(new Set());
    setBulkDeleteOpen(false);
    setRenamingId(null);
  }

  const selectedConversationCount = selectedConversationIds.size;
  const allConversationsSelected =
    filteredConversations.length > 0 && selectedConversationCount === filteredConversations.length;
  const someConversationsSelected = selectedConversationCount > 0 && !allConversationsSelected;
  let conversationHeaderChecked: boolean | "indeterminate" = false;
  if (allConversationsSelected) conversationHeaderChecked = true;
  else if (someConversationsSelected) conversationHeaderChecked = "indeterminate";

  const toggleConversationSelected = React.useCallback((id: number, checked: boolean) => {
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  function toggleAllConversations(checked: boolean) {
    setSelectedConversationIds(
      checked ? new Set(filteredConversations.map((conversation) => conversation.id)) : new Set(),
    );
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedConversationIds(new Set());
  }

  const del = React.useCallback(
    async (id: number) => {
      try {
        await api.deleteConversation(id);
        setSelectedId((current) => (current === id ? null : current));
        setSelectedConversationIds((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        void reloadConvs();
      } catch (e) {
        toast.error("删除失败：" + (e as Error).message);
      }
    },
    [reloadConvs],
  );

  async function deleteSelectedConversations() {
    const ids = [...selectedConversationIds];
    if (ids.length === 0 || bulkDeleting) return;
    setBulkDeleting(true);
    const deleted = new Set<number>();
    const failed: { id: number; error: string }[] = [];
    try {
      for (let offset = 0; offset < ids.length; offset += 100) {
        const result = await api.deleteConversations(ids.slice(offset, offset + 100));
        for (const item of result.items) {
          if (item.ok) deleted.add(item.id);
          else failed.push({ id: item.id, error: item.error ?? "对话不存在" });
        }
      }
      if (deleted.has(selectedId ?? -1)) selectConversation(null);
      setSelectedConversationIds((current) => {
        const next = new Set(current);
        for (const id of deleted) next.delete(id);
        return next;
      });
      if (deleted.size > 0) toast.success(`已删除 ${deleted.size} 个对话`);
      if (failed.length > 0) {
        const details = failed
          .slice(0, 3)
          .map((item) => `#${item.id}（${item.error}）`)
          .join("；");
        toast.error(`${failed.length} 个对话删除失败：${details}${failed.length > 3 ? " 等" : ""}`);
      }
      setBulkDeleteOpen(false);
      // Fully successful → return to the clean list; keep selection mode on if
      // some failed so the user can retry the remaining ones.
      if (failed.length === 0) setSelectionMode(false);
      void reloadConvs();
    } catch (error) {
      toast.error(`批量删除失败：${(error as Error).message}`);
      void reloadConvs();
    } finally {
      setBulkDeleting(false);
    }
  }

  const togglePinned = React.useCallback(
    async (conversation: Conversation) => {
      const pinned = conversationIsPinned(conversation);
      try {
        await api.pinConversation(conversation.id, !pinned);
        void reloadConvs();
      } catch (e) {
        toast.error(`${pinned ? "取消置顶" : "置顶"}失败：${(e as Error).message}`);
      }
    },
    [reloadConvs],
  );

  const startRename = React.useCallback((c: Conversation) => {
    setRenamingId(c.id);
    setRenameText(c.title || "");
  }, []);
  const commitRename = React.useCallback(
    async (id: number, value: string) => {
      const title = value.trim();
      setRenamingId(null);
      if (!title) return;
      try {
        await api.renameConversation(id, title);
        void reloadConvs();
      } catch (e) {
        toast.error("重命名失败：" + (e as Error).message);
      }
    },
    [reloadConvs],
  );
  const cancelRename = React.useCallback(() => setRenamingId(null), []);

  return (
    <div
      data-content-padding="false"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden p-3 sm:p-4 xl:p-6"
    >
      <ConversationWorkspace listOpen={listOpen}>
        {/* left: conversation list */}
        <div className="flex min-h-0 flex-col overflow-hidden border-b bg-muted/20 @min-[56rem]/conversations:border-b-0 @min-[56rem]/conversations:border-r">
          <div className="flex items-center gap-2 px-3 py-2 @min-[56rem]/conversations:hidden">
            <Button
              size="sm"
              variant="ghost"
              className="min-w-0 flex-1 justify-start px-0"
              onClick={() => setListOpen((open) => !open)}
              aria-expanded={listOpen}
              aria-controls="conversation-list-panel"
            >
              <MessageSquareIcon />
              <span className="min-w-0 truncate">{listOpen ? "收起会话列表" : "会话列表"}</span>
              <ChevronDownIcon className={cn("ml-auto transition-transform", !listOpen && "-rotate-90")} />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => selectConversation(null)} aria-label="新建对话">
              <PlusIcon />
            </Button>
          </div>
          <div
            className={cn(
              "flex shrink-0 flex-col gap-2 border-b p-2",
              !listOpen && "@max-[56rem]/conversations:hidden",
            )}
          >
            <Button size="sm" className="w-full" onClick={() => selectConversation(null)}>
              <PlusIcon /> 新建对话
            </Button>
            <Select
              value={agentFilter === null ? "all" : `agent:${agentFilter}`}
              onValueChange={(value) => changeAgentFilter(value === "all" ? null : value.slice(6))}
              disabled={bulkDeleting}
            >
              <SelectTrigger size="sm" className="w-full min-w-0" aria-label="按 Agent 筛选对话">
                <Bot />
                <SelectValue placeholder="全部 Agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">全部 Agent</SelectItem>
                  {agentFilterOptions.map((agent) => (
                    <SelectItem key={agent.key} value={`agent:${agent.key}`}>
                      {agent.name}（{agent.count}）
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {convs.length > 0 &&
              (selectionMode ? (
                <div className="flex items-center gap-2 px-1">
                  <Checkbox
                    checked={conversationHeaderChecked}
                    onCheckedChange={(checked) => toggleAllConversations(checked === true)}
                    aria-label="选择当前筛选的全部对话"
                    disabled={filteredConversations.length === 0 || bulkDeleting}
                  />
                  <span className="text-muted-foreground min-w-0 flex-1 text-xs tabular-nums">
                    {selectedConversationCount > 0 ? `已选 ${selectedConversationCount} 个` : conversationCountLabel}
                  </span>
                  {selectedConversationCount > 0 && (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={bulkDeleting}
                      onClick={() => setBulkDeleteOpen(true)}
                    >
                      <Trash2Icon data-icon="inline-start" />
                      删除
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={exitSelectionMode}>
                    完成
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 px-1">
                  <span className="text-muted-foreground min-w-0 flex-1 text-xs tabular-nums">
                    {conversationCountLabel}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => setSelectionMode(true)}
                    disabled={filteredConversations.length === 0}
                  >
                    <ListChecksIcon data-icon="inline-start" />
                    多选
                  </Button>
                </div>
              ))}
          </div>
          <ScrollArea
            id="conversation-list-panel"
            key={agentFilter === null ? "all" : `agent:${agentFilter}`}
            type="auto"
            className={cn(
              "min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!",
              !listOpen && "@max-[56rem]/conversations:hidden",
            )}
          >
            <div className="flex min-w-0 flex-col gap-0.5 p-2">
              {filteredConversations.length === 0 && (
                <p className="text-muted-foreground px-2 py-6 text-center text-xs">
                  {agentFilter === null ? "暂无对话" : "该 Agent 暂无对话"}
                </p>
              )}
              {pinnedConversations.map((c) => (
                <ConversationItem
                  key={c.id}
                  conv={c}
                  agent={agentByKey.get(c.agent_key)}
                  active={selectedId === c.id}
                  renaming={renamingId === c.id}
                  renameText={renamingId === c.id ? renameText : ""}
                  onSelect={selectConversation}
                  onStartRename={startRename}
                  onRenameText={setRenameText}
                  onCommitRename={commitRename}
                  onCancelRename={cancelRename}
                  onTogglePinned={togglePinned}
                  onDelete={del}
                  selectionMode={selectionMode}
                  selectedForDelete={selectedConversationIds.has(c.id)}
                  onSelectedForDeleteChange={toggleConversationSelected}
                />
              ))}
              {agentGroups.map((group) => {
                const collapsed = collapsedAgents.has(group.key);
                return (
                  <React.Fragment key={group.key}>
                    <AgentGroupHeader
                      group={group}
                      collapsed={collapsed}
                      hasActive={group.conversations.some((c) => c.id === selectedId)}
                      onToggle={toggleAgentCollapsed}
                    />
                    {!collapsed &&
                      group.conversations.map((c) => (
                        <ConversationItem
                          key={c.id}
                          conv={c}
                          agent={agentByKey.get(c.agent_key)}
                          showAgent={false}
                          active={selectedId === c.id}
                          renaming={renamingId === c.id}
                          renameText={renamingId === c.id ? renameText : ""}
                          onSelect={selectConversation}
                          onStartRename={startRename}
                          onRenameText={setRenameText}
                          onCommitRename={commitRename}
                          onCancelRename={cancelRename}
                          onTogglePinned={togglePinned}
                          onDelete={del}
                          selectionMode={selectionMode}
                          selectedForDelete={selectedConversationIds.has(c.id)}
                          onSelectedForDeleteChange={toggleConversationSelected}
                        />
                      ))}
                  </React.Fragment>
                );
              })}
              {visibleConversationCount < filteredConversations.length && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-1 w-full"
                  onClick={() => setVisibleConversationCount((count) => count + CONVERSATION_LIST_PAGE)}
                >
                  加载更多
                </Button>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* right: chat view */}
        <div className="@container/conversation flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          {selected ? (
            <ChatView
              key={selected.id}
              conv={selected}
              agents={agents}
              profiles={profiles}
              drafts={drafts}
              onTitleMaybeChanged={reloadConvs}
              onConvUpdated={reloadConvs}
            />
          ) : sourceRequested ? (
            <div role="status" className="p-6 text-sm text-muted-foreground">
              {convsLoaded ? "对话已被删除" : "正在加载对应对话…"}
            </div>
          ) : (
            <DraftChat
              agents={chatAgents}
              profiles={profiles}
              onStarted={(c, pending) => {
                if (agentFilter !== null && agentFilter !== c.agent_key) changeAgentFilter(null);
                // Insert the new conversation immediately so `selected` resolves to
                // it on this render (switching to ChatView right away, before the
                // async reloadConvs lands); reloadConvs then reconciles titles etc.
                if (pending)
                  drafts.updateDraft(`conversation:${c.id}`, {
                    text: pending.input ?? "",
                    attachments: pending.attachments ?? [],
                  });
                setConvs((prev) => {
                  if (prev.some((item) => item.id === c.id)) return prev;
                  const firstUnpinned = prev.findIndex((item) => !conversationIsPinned(item));
                  const insertAt = firstUnpinned < 0 ? prev.length : firstUnpinned;
                  return [...prev.slice(0, insertAt), c, ...prev.slice(insertAt)];
                });
                setSelectedId(c.id);
                setListOpen(false);
                void reloadConvs();
              }}
            />
          )}
        </div>
      </ConversationWorkspace>
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除选中的 {selectedConversationCount} 个对话？</AlertDialogTitle>
            <AlertDialogDescription>对话消息和执行记录将一并删除，此操作不可撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={bulkDeleting || selectedConversationCount === 0}
              onClick={(event) => {
                event.preventDefault();
                void deleteSelectedConversations();
              }}
            >
              {bulkDeleting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              {bulkDeleting ? "删除中" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
