"use client";

import * as React from "react";
import { toast } from "sonner";
import { PlayIcon, PlusIcon, RotateCcwIcon, SaveIcon, SearchIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import type { Agent, Tool } from "@/lib/types";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";

// Traffic tools are host tools gated by the global 流量捕获 switch: bindable, but
// only usable when capture is on. Keep in sync with traffic.SeedToolMetas.
const TRAFFIC_TOOL_KEYS = new Set(["traffic_search", "traffic_get"]);

// paramRows flattens schema.properties into an ordered row list for editing.
// name/type/required are read-only (welded to the Go handler); description/default
// are editable. Non-scalar params (array/object) can't carry an editable default.
// parentKey is set for rows that live inside an array param's items.properties.
type ParamRow = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultStr: string; // "" = no default declared
  scalar: boolean;
  parentKey?: string; // set when this is a sub-field of an array param's items
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRows(schema: Record<string, any>): ParamRow[] {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set<string>((schema?.required as string[]) ?? []);
  const rows: ParamRow[] = [];
  for (const [name, p] of Object.entries(props)) {
    const type = String(p?.type ?? "");
    const hasDefault = p != null && "default" in p && (p as Record<string, unknown>).default != null;
    rows.push({
      name,
      type,
      required: required.has(name),
      description: String(p?.description ?? ""),
      defaultStr: hasDefault ? String((p as Record<string, unknown>).default) : "",
      scalar: ["string", "integer", "number", "boolean"].includes(type),
    });
    // Expand items.properties for array params so sub-fields are editable.
    if (type === "array") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itemProps = (p as any)?.items?.properties as Record<string, Record<string, unknown>> | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itemRequired = new Set<string>(((p as any)?.items?.required as string[]) ?? []);
      if (itemProps) {
        for (const [subName, subP] of Object.entries(itemProps)) {
          const subType = String((subP as Record<string, unknown>)?.type ?? "");
          const subHasDefault = subP != null && "default" in subP && subP.default != null;
          rows.push({
            name: subName,
            type: subType,
            required: itemRequired.has(subName),
            description: String(subP?.description ?? ""),
            defaultStr: subHasDefault ? String(subP.default) : "",
            scalar: ["string", "integer", "number", "boolean"].includes(subType),
            parentKey: name,
          });
        }
      }
    }
  }
  return rows;
}

// coerceDefault turns the edited default string back into a typed JSON value, or
// undefined to drop the "default" key entirely.
function coerceDefault(type: string, raw: string): unknown {
  const s = raw.trim();
  if (s === "") return undefined;
  if (type === "integer" || type === "number") {
    const n = Number(s);
    return Number.isNaN(n) ? undefined : n;
  }
  if (type === "boolean") return s === "true";
  return raw;
}

// applyRows writes edited rows back into a deep-copied schema (structure untouched).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyRows(schema: Record<string, any>, rows: ParamRow[]): Record<string, any> {
  const next = structuredClone(schema ?? {});
  const props = (next.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const r of rows) {
    if (r.parentKey) {
      // Sub-field of an array param's items.properties
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parent = props[r.parentKey] as any;
      const subP = parent?.items?.properties?.[r.name] as Record<string, unknown> | undefined;
      if (!subP) continue;
      subP.description = r.description;
      if (r.scalar) {
        const dv = coerceDefault(r.type, r.defaultStr);
        if (dv === undefined) delete subP.default;
        else subP.default = dv;
      }
    } else {
      const p = props[r.name];
      if (!p) continue;
      p.description = r.description;
      if (r.scalar) {
        const dv = coerceDefault(r.type, r.defaultStr);
        if (dv === undefined) delete p.default;
        else p.default = dv;
      }
    }
  }
  return next;
}

// ToolEditor is the full edit form for one tool, rendered inside the drawer.
function ToolEditor({
  tool,
  agents,
  captureOn,
  onSaved,
  onClose,
}: {
  tool: Tool;
  agents: Agent[];
  captureOn: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  // traffic tools can't be bound/enabled until the global 流量捕获 switch is on.
  const trafficGated = TRAFFIC_TOOL_KEYS.has(tool.key) && !captureOn;
  const [description, setDescription] = React.useState(tool.description);
  const [bound, setBound] = React.useState<string[]>(tool.agents);
  const [enabled, setEnabled] = React.useState(tool.enabled);
  const [rows, setRows] = React.useState<ParamRow[]>(() => toRows(tool.schema));
  const [saving, setSaving] = React.useState(false);

  const setRow = (i: number, patch: Partial<ParamRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggleAgent = (k: string) => setBound((b) => (b.includes(k) ? b.filter((x) => x !== k) : [...b, k]));

  async function save() {
    setSaving(true);
    try {
      await api.saveTool(tool.key, {
        description,
        schema: applyRows(tool.schema, rows),
        agents: bound,
        enabled,
      });
      toast.success(`已保存工具「${tool.key}」`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error("保存失败：" + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function reset() {
    try {
      await api.resetTool(tool.key);
      toast.success(`已恢复「${tool.key}」为代码默认`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error("恢复失败：" + (e as Error).message);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
        {trafficGated && (
          <div className="border-amber-500/40 bg-amber-500/10 text-muted-foreground rounded-md border px-3 py-2 text-xs">
            该工具依赖<b>流量捕获</b>。请先在「系统配置」开启流量捕获，才能绑定给 Agent 并启用。
          </div>
        )}
        {/* binding + switch */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground text-xs">绑定 Agent（决定该工具给哪些 Agent）</Label>
            <div className="flex flex-wrap gap-3">
              {agents.map((ag) => (
                <Label key={ag.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={bound.includes(ag.key)}
                    disabled={trafficGated}
                    onCheckedChange={() => toggleAgent(ag.key)}
                  />
                  {ag.name}
                  <span className="text-muted-foreground font-mono text-xs">{ag.key}</span>
                </Label>
              ))}
              {agents.length === 0 && <span className="text-muted-foreground text-xs">（无 Agent）</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} id={`en-${tool.key}`} />
            <Label htmlFor={`en-${tool.key}`} className="text-sm">
              启用
            </Label>
          </div>
        </div>

        {/* description */}
        <div className="grid gap-1.5">
          <Label htmlFor="tool-description" className="text-muted-foreground text-xs">
            工具描述（发送给模型）
          </Label>
          <Textarea
            id="tool-description"
            className="font-mono text-xs"
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* params */}
        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">参数（名称 / 类型 / 必填只读；描述与默认值可改）</Label>
          {rows.length === 0 && <span className="text-muted-foreground text-xs">（无参数）</span>}
          {rows.map((r, i) => (
            <div
              key={(r.parentKey ?? "") + "." + r.name}
              className={
                r.parentKey ? "border-l-2 border-muted ml-3 pl-3 grid gap-2 py-2" : "grid gap-2 rounded-md border p-3"
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                {r.parentKey && <span className="text-muted-foreground font-mono text-xs">↳</span>}
                <span className="font-mono text-sm">{r.name}</span>
                <Badge variant="secondary" className="px-1.5 py-0 text-xs">
                  {r.type || "?"}
                </Badge>
                {r.required && (
                  <Badge variant="outline" className="px-1.5 py-0 text-xs">
                    必填
                  </Badge>
                )}
                {r.parentKey && <span className="text-muted-foreground text-xs">items 子字段</span>}
              </div>
              <div className="grid gap-2">
                <div className="grid gap-1">
                  <Label className="text-muted-foreground text-xs">描述</Label>
                  <Input
                    className="text-xs"
                    aria-label={`${r.parentKey ? `${r.parentKey}.` : ""}${r.name} 描述`}
                    value={r.description}
                    onChange={(e) => setRow(i, { description: e.target.value })}
                  />
                </div>
                <div className="grid gap-1">
                  <Label className="text-muted-foreground text-xs">默认值</Label>
                  <Input
                    className="text-xs"
                    placeholder={r.scalar ? "（空=无默认）" : "仅标量支持"}
                    disabled={!r.scalar}
                    aria-label={`${r.parentKey ? `${r.parentKey}.` : ""}${r.name} 默认值`}
                    value={r.defaultStr}
                    onChange={(e) => setRow(i, { defaultStr: e.target.value })}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Separator className="mt-4" />
      <div className="flex flex-wrap gap-2 p-4">
        <Button size="sm" onClick={save} disabled={saving}>
          <SaveIcon /> 保存
        </Button>
        <Button size="sm" variant="outline" onClick={reset}>
          <RotateCcwIcon /> 恢复默认
        </Button>
      </div>
    </div>
  );
}

const TOOL_PURPOSES = [
  { value: "tasks", label: "任务与目标" },
  { value: "assets", label: "资产与范围" },
  { value: "findings", label: "发现与复测" },
  { value: "traffic", label: "流量与证据" },
  { value: "execution", label: "执行过程" },
  { value: "extensions", label: "能力配置" },
  { value: "other", label: "其他" },
];

function toolPurpose(tool: Tool): string {
  const key = tool.key.toLowerCase();
  if (/finding|retest/.test(key)) return "findings";
  if (/traffic/.test(key)) return "traffic";
  if (/asset|compan|scope/.test(key)) return "assets";
  if (/mcp|skill|custom_tool|llm_profile/.test(key) || !tool.system) return "extensions";
  if (/graph|node|fact|worker|trace|digest/.test(key)) return "execution";
  if (/task|goal|constraint|hint|intent|kill_work|steer_work/.test(key)) return "tasks";
  return "other";
}

function ToolGridCard({
  tool,
  onClick,
  compact,
  agents,
}: {
  tool: Tool;
  onClick: () => void;
  compact: boolean;
  agents: Agent[];
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`编辑工具 ${tool.key}`}
      className={`min-w-0 hover:border-primary/50 hover:bg-muted/40 focus-visible:ring-ring flex flex-col gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none ${compact ? "sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] sm:items-center sm:gap-5" : ""}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-all font-mono text-sm font-medium">{tool.key}</span>
        {!tool.system && (
          <Badge variant="outline" className="text-xs">
            {tool.kind}
          </Badge>
        )}
        {tool.deferred && (
          <Badge variant="outline" className="text-xs">
            按需加载
          </Badge>
        )}
        {!tool.enabled && (
          <Badge variant="outline" className="text-xs text-destructive">
            已停用
          </Badge>
        )}
      </div>
      <p
        className={`min-w-0 text-muted-foreground text-sm leading-relaxed ${compact ? "line-clamp-2" : "line-clamp-2 min-h-10"}`}
      >
        {tool.description || "暂无用途说明，可打开工具补充。"}
      </p>
      <div className="mt-auto flex min-w-0 flex-wrap items-center gap-1.5">
        {tool.agents.length === 0 && <span className="text-muted-foreground text-xs">未绑定 Agent</span>}
        {tool.agents.map((key) => (
          <Badge key={key} variant="outline" className="max-w-full text-xs">
            <span className="truncate">{agents.find((a) => a.key === key)?.name || key}</span>
          </Badge>
        ))}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">调用 {tool.calls ?? 0} 次</span>
      </div>
    </button>
  );
}

export default function ToolsPage() {
  const [tools, setTools] = React.useState<Tool[]>([]);
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [captureOn, setCaptureOn] = React.useState(false);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [customEdit, setCustomEdit] = React.useState<Tool | "new" | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");

  const reload = React.useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [nextTools, nextAgents, settings] = await Promise.all([api.tools(), api.agents(), api.settings()]);
      setTools(nextTools);
      setAgents(nextAgents);
      setCaptureOn(!!settings.traffic_capture);
    } catch (e) {
      setLoadError(`读取工具配置失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    void reload();
  }, [reload]);

  const [query, setQuery] = React.useState("");
  const [purpose, setPurpose] = React.useState("all");
  const [agentFilter, setAgentFilter] = React.useState("all");
  const [catalogView, setCatalogView] = React.useState<"grid" | "list">("list");
  const filtersActive = query.trim() !== "" || purpose !== "all" || agentFilter !== "all";
  const clearFilters = () => {
    setQuery("");
    setPurpose("all");
    setAgentFilter("all");
  };

  const selected = tools.find((t) => t.key === selectedKey) ?? null;
  const matchTool = React.useCallback(
    (t: Tool) => {
      if (purpose !== "all" && toolPurpose(t) !== purpose) return false;
      if (agentFilter === "unbound" ? t.agents.length > 0 : agentFilter !== "all" && !t.agents.includes(agentFilter))
        return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        t.key.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.agents.some((a) => a.toLowerCase().includes(q))
      );
    },
    [query, purpose, agentFilter],
  );
  const systemTools = tools.filter((t) => t.system && matchTool(t));
  const customTools = tools.filter((t) => !t.system && matchTool(t));
  const allSystemCount = tools.filter((t) => t.system).length;
  const allCustomCount = tools.filter((t) => !t.system).length;
  // clicking a built-in tool opens the binding drawer; a custom tool opens its full editor.
  const openTool = (t: Tool) => (t.system ? setSelectedKey(t.key) : setCustomEdit(t));

  return (
    <div className="flex flex-1 flex-col gap-4 md:gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">工具</h1>
          <p className="text-muted-foreground text-sm">按用途和 Agent 查找工具，查看说明并管理配置</p>
        </div>
        <div className="relative w-full sm:w-72">
          <SearchIcon className="text-muted-foreground absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
          <Input
            className="h-8 pl-8 text-sm"
            aria-label="搜索工具"
            placeholder="搜索工具名、描述、Agent…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={purpose} onValueChange={setPurpose}>
          <SelectTrigger aria-label="按工具用途筛选" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部用途</SelectItem>
            {TOOL_PURPOSES.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger aria-label="按绑定 Agent 筛选" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部 Agent</SelectItem>
            <SelectItem value="unbound">未绑定 Agent</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.key} value={agent.key}>
                {agent.name || agent.key}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            清除筛选
          </Button>
        )}
        <fieldset className="ml-auto flex gap-1 rounded-lg border p-1">
          <legend className="sr-only">工具目录视图</legend>
          <Button
            size="sm"
            variant={catalogView === "list" ? "secondary" : "ghost"}
            aria-pressed={catalogView === "list"}
            onClick={() => setCatalogView("list")}
          >
            列表
          </Button>
          <Button
            size="sm"
            variant={catalogView === "grid" ? "secondary" : "ghost"}
            aria-pressed={catalogView === "grid"}
            onClick={() => setCatalogView("grid")}
          >
            卡片
          </Button>
        </fieldset>
      </div>
      {loadError && (
        <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">
          <p>{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            重试
          </Button>
        </div>
      )}
      {loading && (
        <p role="status" className="text-muted-foreground text-sm">
          正在读取工具配置…
        </p>
      )}
      {!loading && !loadError && (
        <Tabs defaultValue="system">
          <TabsList>
            <TabsTrigger value="system">系统工具</TabsTrigger>
            <TabsTrigger value="custom">自定义工具</TabsTrigger>
          </TabsList>

          <TabsContent value="system">
            <Card>
              <CardHeader>
                <CardTitle>系统工具</CardTitle>
                <CardDescription>
                  {filtersActive
                    ? `${systemTools.length} / ${allSystemCount} 个匹配，选择工具查看说明和配置`
                    : `共 ${allSystemCount} 个，选择工具查看说明和配置`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {systemTools.length === 0 ? (
                  <p className="text-muted-foreground py-6 text-center text-sm">
                    {filtersActive ? "没有匹配的系统工具，请调整或清除筛选。" : "暂无系统工具"}
                  </p>
                ) : (
                  <div
                    className={
                      catalogView === "grid" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "flex flex-col gap-3"
                    }
                  >
                    {systemTools.map((t) => (
                      <ToolGridCard
                        key={t.key}
                        tool={t}
                        onClick={() => openTool(t)}
                        compact={catalogView === "list"}
                        agents={agents}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="custom">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>自定义工具</CardTitle>
                    <CardDescription>
                      {filtersActive
                        ? `shell/command/script/http，${customTools.length} / ${allCustomCount} 个匹配，选择工具编辑`
                        : `shell(bash 声明) / command(命令) / script(Python) / http(API)，共 ${allCustomCount} 个，选择工具编辑`}
                    </CardDescription>
                  </div>
                  <Button size="sm" onClick={() => setCustomEdit("new")}>
                    <PlusIcon /> 新建自定义工具
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {customTools.length === 0 ? (
                  <p className="text-muted-foreground py-6 text-center text-sm">
                    {filtersActive
                      ? "没有匹配的自定义工具，请调整或清除筛选。"
                      : "暂无自定义工具，点击「新建自定义工具」开始配置。"}
                  </p>
                ) : (
                  <div
                    className={
                      catalogView === "grid" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "flex flex-col gap-3"
                    }
                  >
                    {customTools.map((t) => (
                      <ToolGridCard
                        key={t.key}
                        tool={t}
                        onClick={() => openTool(t)}
                        compact={catalogView === "list"}
                        agents={agents}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelectedKey(null)}>
        <SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader className="px-4">
                <SheetTitle className="font-mono">{selected.key}</SheetTitle>
                <SheetDescription>编辑描述、参数默认值与 Agent 绑定</SheetDescription>
              </SheetHeader>
              <ToolEditor
                key={selected.key}
                tool={selected}
                agents={agents}
                captureOn={captureOn}
                onSaved={reload}
                onClose={() => setSelectedKey(null)}
              />
            </>
          )}
        </SheetContent>
      </Sheet>

      <CustomToolDialog
        edit={customEdit}
        agents={agents}
        onClose={() => setCustomEdit(null)}
        onSaved={() => {
          setCustomEdit(null);
          reload();
        }}
      />
    </div>
  );
}

// ---- 自定义工具编辑器 ----

type ExecState = {
  command: string;
  code: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  timeout_ms: string;
  proxy: string;
  use_recording_proxy: boolean;
};

function CustomToolDialog({
  edit,
  agents,
  onClose,
  onSaved,
}: {
  edit: Tool | "new" | null;
  agents: Agent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = edit === "new";
  const tool = edit && edit !== "new" ? edit : null;
  const [key, setKey] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [kind, setKind] = React.useState<"shell" | "command" | "script" | "http">("shell");
  const [ex, setEx] = React.useState<ExecState>({
    command: "",
    code: "",
    method: "GET",
    url: "",
    headers: "",
    body: "",
    timeout_ms: "",
    proxy: "",
    use_recording_proxy: false,
  });
  const [schemaText, setSchemaText] = React.useState("");
  const [bound, setBound] = React.useState<string[]>([]);
  const [deferred, setDeferred] = React.useState(false);
  const [enabled, setEnabled] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [paramsText, setParamsText] = React.useState("");
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ output: string; is_error: boolean } | null>(null);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  // (re)load form state when opening.
  React.useEffect(() => {
    if (!edit) return;
    setDeleteOpen(false);
    setParamsText("");
    setTestResult(null);
    if (edit === "new") {
      setKey("");
      setDescription("");
      setKind("shell");
      setEx({
        command: "",
        code: "",
        method: "GET",
        url: "",
        headers: "",
        body: "",
        timeout_ms: "",
        proxy: "",
        use_recording_proxy: false,
      });
      setSchemaText("");
      setBound([]);
      setDeferred(false);
      setEnabled(true);
      return;
    }
    const t = edit;
    const e = (t.exec ?? {}) as Record<string, unknown>;
    setKey(t.key);
    setDescription(t.description);
    setKind((t.kind as "shell" | "command" | "script" | "http") ?? "shell");
    setEx({
      command: String(e.command ?? ""),
      code: String(e.code ?? ""),
      method: String(e.method ?? "GET"),
      url: String(e.url ?? ""),
      headers: e.headers ? JSON.stringify(e.headers, null, 2) : "",
      body: String(e.body ?? ""),
      timeout_ms: e.timeout_ms ? String(e.timeout_ms) : "",
      proxy: String(e.proxy ?? ""),
      use_recording_proxy: !!e.use_recording_proxy,
    });
    setSchemaText(t.schema && Object.keys(t.schema).length ? JSON.stringify(t.schema, null, 2) : "");
    setBound(t.agents ?? []);
    setDeferred(!!t.deferred);
    setEnabled(t.enabled);
  }, [edit]);

  const toggleAgent = (k: string) => setBound((b) => (b.includes(k) ? b.filter((x) => x !== k) : [...b, k]));

  function buildExec(): Record<string, unknown> {
    if (kind === "shell") return {};
    const t = ex.timeout_ms ? Number(ex.timeout_ms) : undefined;
    if (kind === "command") return { command: ex.command, timeout_ms: t };
    if (kind === "script") return { code: ex.code, timeout_ms: t };
    let headers: Record<string, string> = {};
    if (ex.headers.trim()) {
      try {
        headers = JSON.parse(ex.headers);
      } catch {
        /* validated on save */
      }
    }
    return {
      method: ex.method,
      url: ex.url,
      headers,
      body: ex.body,
      timeout_ms: t,
      proxy: ex.proxy,
      use_recording_proxy: ex.use_recording_proxy,
    };
  }

  async function save() {
    if (isNew && !/^[a-z][a-z0-9_]*$/.test(key.trim())) {
      toast.error("key 需小写字母开头，仅含小写字母/数字/下划线");
      return;
    }
    let schema: Record<string, unknown> = {};
    if (schemaText.trim()) {
      try {
        schema = JSON.parse(schemaText);
      } catch {
        toast.error("参数 JSON Schema 格式错误");
        return;
      }
    }
    if (kind === "http" && ex.headers.trim()) {
      try {
        JSON.parse(ex.headers);
      } catch {
        toast.error("headers JSON 格式错误");
        return;
      }
    }
    if (kind === "http") {
      const props = (schema as { properties?: Record<string, unknown> }).properties;
      if (!props || Object.keys(props).length === 0) {
        toast.error("http 工具必须提供参数 JSON Schema（含 properties，不能留空）");
        return;
      }
    }
    setSaving(true);
    const payload = {
      description,
      schema: kind === "shell" ? {} : schema,
      agents: bound,
      enabled,
      kind,
      exec: buildExec(),
      deferred: kind === "shell" ? false : deferred,
    };
    try {
      if (isNew) await api.createCustomTool({ key: key.trim(), ...payload });
      else await api.updateCustomTool(tool!.key, payload);
      toast.success(isNew ? "已创建自定义工具" : "已保存");
      onSaved();
    } catch (e) {
      toast.error("保存失败：" + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function del() {
    if (!tool) return;
    await api.deleteCustomTool(tool.key);
    toast.success("已删除");
    onSaved();
  }
  // runTest dry-runs the CURRENT form (unsaved) with the sample params, so a
  // template/script/request can be debugged before saving.
  async function runTest() {
    let params: Record<string, unknown> = {};
    if (paramsText.trim()) {
      try {
        params = JSON.parse(paramsText);
      } catch {
        toast.error("测试参数 JSON 格式错误");
        return;
      }
    }
    if (kind === "http" && ex.headers.trim()) {
      try {
        JSON.parse(ex.headers);
      } catch {
        toast.error("headers JSON 格式错误");
        return;
      }
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testCustomTool({ kind, exec: buildExec(), params });
      setTestResult(r);
    } catch (e) {
      setTestResult({ output: (e as Error).message, is_error: true });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Sheet open={!!edit} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      >
        <SheetHeader className="px-4">
          <SheetTitle>{isNew ? "新建自定义工具" : `编辑 ${tool?.key}`}</SheetTitle>
          <SheetDescription>
            shell=bash 环境声明(只需名称+描述，告知模型可用 bash 调用)；command/script/http 需写执行规格。
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <div className="grid gap-1.5">
            <Label htmlFor="custom-tool-key" className="text-xs">
              Key
            </Label>
            <Input
              id="custom-tool-key"
              className="font-mono"
              placeholder="如 nmap_scan"
              value={key}
              disabled={!isNew}
              onChange={(e) => setKey(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="custom-tool-description" className="text-xs">
              描述(发给模型)
            </Label>
            <Textarea
              id="custom-tool-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs" htmlFor="custom-tool-kind">
              类型
            </Label>
            <Select value={kind} onValueChange={(v) => setKind(v as "shell" | "command" | "script" | "http")}>
              <SelectTrigger id="custom-tool-kind" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shell">shell（bash 环境声明）</SelectItem>
                <SelectItem value="command">command（shell 命令模板）</SelectItem>
                <SelectItem value="script">script（Python 脚本）</SelectItem>
                <SelectItem value="http">http（API 请求）</SelectItem>
              </SelectContent>
            </Select>
            {kind === "shell" && (
              <p className="text-muted-foreground text-xs">
                适合 nmap、sqlmap、ffuf 等出名工具——模型已知用法，只需声明"可在 bash 中调用"即可。名称+描述会追加到 Bash
                工具描述里。
              </p>
            )}
          </div>

          {kind === "command" && (
            <div className="grid gap-1.5">
              <Label htmlFor="custom-tool-command" className="text-xs">
                命令模板（占位符 {"{param}"}，如 nmap -p {"{ports}"} {"{target}"}）
              </Label>
              <Textarea
                id="custom-tool-command"
                className="font-mono text-xs"
                rows={2}
                value={ex.command}
                onChange={(e) => setEx({ ...ex, command: e.target.value })}
              />
            </div>
          )}
          {kind === "script" && (
            <div className="grid gap-1.5">
              <Label htmlFor="custom-tool-code" className="text-xs">
                Python 正文（参数走 stdin JSON / os.environ["TOOL_X"]）
              </Label>
              <Textarea
                id="custom-tool-code"
                className="font-mono text-xs"
                rows={10}
                value={ex.code}
                placeholder={"import json,sys\nargs=json.load(sys.stdin)\nprint(...)"}
                onChange={(e) => setEx({ ...ex, code: e.target.value })}
              />
            </div>
          )}
          {kind === "http" && (
            <div className="grid gap-2">
              <div className="flex gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="custom-tool-method" className="text-xs">
                    Method
                  </Label>
                  <Input
                    id="custom-tool-method"
                    className="w-24"
                    value={ex.method}
                    onChange={(e) => setEx({ ...ex, method: e.target.value })}
                  />
                </div>
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <Label htmlFor="custom-tool-url" className="text-xs">
                    URL（可含 {"{param}"}）
                  </Label>
                  <Input
                    id="custom-tool-url"
                    className="font-mono text-xs"
                    value={ex.url}
                    onChange={(e) => setEx({ ...ex, url: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="custom-tool-headers" className="text-xs">
                  Headers（JSON，可含 {"{param}"}）
                </Label>
                <Textarea
                  id="custom-tool-headers"
                  className="font-mono text-xs"
                  rows={2}
                  value={ex.headers}
                  placeholder={'{"Authorization": "Bearer {token}"}'}
                  onChange={(e) => setEx({ ...ex, headers: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="custom-tool-body" className="text-xs">
                  Body（可含 {"{param}"}）
                </Label>
                <Textarea
                  id="custom-tool-body"
                  className="font-mono text-xs"
                  rows={2}
                  value={ex.body}
                  onChange={(e) => setEx({ ...ex, body: e.target.value })}
                />
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="custom-tool-proxy" className="text-xs">
                    代理 URL（空=直连）
                  </Label>
                  <Input
                    id="custom-tool-proxy"
                    className="font-mono text-xs w-56"
                    value={ex.proxy}
                    onChange={(e) => setEx({ ...ex, proxy: e.target.value })}
                  />
                </div>
                <Label className="mt-4 flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ex.use_recording_proxy}
                    onCheckedChange={(v) => setEx({ ...ex, use_recording_proxy: !!v })}
                  />
                  走记录代理
                </Label>
              </div>
            </div>
          )}

          {kind !== "shell" && (
            <div className="flex items-center gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="custom-tool-timeout" className="text-xs">
                  超时(ms，空=默认)
                </Label>
                <Input
                  id="custom-tool-timeout"
                  type="number"
                  className="w-32"
                  value={ex.timeout_ms}
                  onChange={(e) => setEx({ ...ex, timeout_ms: e.target.value })}
                />
              </div>
            </div>
          )}

          {kind !== "shell" && (
            <div className="grid gap-1.5">
              <Label className="text-xs">
                参数 JSON Schema
                {kind === "http" ? "（http 工具必填，需含 properties）" : "（留空 = 自动给 {args} 薄壳）"}
              </Label>
              <Textarea
                id="custom-tool-schema"
                aria-label="参数 JSON Schema"
                className="font-mono text-xs"
                rows={4}
                value={schemaText}
                placeholder={'{"type":"object","properties":{"target":{"type":"string"}},"required":["target"]}'}
                onChange={(e) => setSchemaText(e.target.value)}
              />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label className="text-muted-foreground text-xs">绑定 Agent</Label>
            <div className="flex flex-wrap gap-3">
              {agents.map((a) => (
                <Label key={a.key} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={bound.includes(a.key)} onCheckedChange={() => toggleAgent(a.key)} />
                  {a.name}
                  <span className="text-muted-foreground font-mono text-xs">{a.key}</span>
                </Label>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <Label className="flex items-center gap-2 text-sm">
              <Switch checked={enabled} onCheckedChange={setEnabled} /> 启用
            </Label>
            {kind !== "shell" && (
              <Label className="flex items-center gap-2 text-sm">
                <Switch checked={deferred} onCheckedChange={setDeferred} /> deferred（大量不常用工具才开）
              </Label>
            )}
          </div>

          {kind !== "shell" && (
            <div className="grid gap-1.5 rounded-md border p-3">
              <Label className="text-xs font-medium">测试运行（用当前表单，不会保存）</Label>
              <Textarea
                id="custom-tool-test-params"
                aria-label="测试参数 JSON"
                className="font-mono text-xs"
                rows={2}
                value={paramsText}
                placeholder={'示例参数 JSON，如 {"target":"example.com"}'}
                onChange={(e) => setParamsText(e.target.value)}
              />
              <div>
                <Button size="sm" variant="outline" onClick={runTest} disabled={testing}>
                  <PlayIcon /> {testing ? "运行中…" : "测试运行"}
                </Button>
              </div>
              {testResult && (
                <pre
                  className={
                    "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs " +
                    (testResult.is_error ? "text-destructive" : "")
                  }
                >
                  {testResult.output || "（无输出）"}
                </pre>
              )}
            </div>
          )}
        </div>

        <Separator />
        <div className="flex items-center gap-2 p-4">
          <Button size="sm" onClick={save} disabled={saving}>
            <SaveIcon /> {isNew ? "创建" : "保存"}
          </Button>
          {!isNew && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2Icon /> 删除
            </Button>
          )}
        </div>
        <ConfirmActionDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={`删除自定义工具「${tool?.key ?? ""}」？`}
          description="删除后该工具及其绑定配置将立即移除，且无法撤销。"
          onConfirm={del}
          confirmLabel="删除"
        />
      </SheetContent>
    </Sheet>
  );
}
