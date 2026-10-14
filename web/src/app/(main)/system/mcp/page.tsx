"use client";

import * as React from "react";
import { toast } from "sonner";
import { PlusIcon, RefreshCwIcon, ServerIcon, Trash2Icon } from "lucide-react";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { MCPServer, MCPTool, Agent } from "@/lib/types";

type Transport = "stdio" | "http" | "sse";
type FormState = {
  name: string;
  transport: Transport;
  command: string;
  args: string;
  url: string;
  env: string;
  insecure: boolean;
};
const emptyForm: FormState = {
  name: "",
  transport: "stdio",
  command: "",
  args: "[]",
  url: "",
  env: "",
  insecure: false,
};

export default function MCPPage() {
  const [servers, setServers] = React.useState<MCPServer[]>([]);
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [visibility, setVisibility] = React.useState<Record<number, string[]>>({});

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MCPServer | null>(null); // null = add mode
  const [tab, setTab] = React.useState<"config" | "tools">("config");
  const [form, setForm] = React.useState<FormState>(emptyForm);
  const [saving, setSaving] = React.useState(false);
  const [tools, setTools] = React.useState<MCPTool[]>([]);
  const [toolsLoading, setToolsLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");
  const [toolsError, setToolsError] = React.useState("");
  const [formError, setFormError] = React.useState("");
  const [invalidField, setInvalidField] = React.useState<keyof FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<MCPServer | null>(null);
  const [updating, setUpdating] = React.useState(false);
  const toolsRequest = React.useRef(0);
  const loadRequest = React.useRef(0);
  const updateLock = React.useRef(false);

  const load = React.useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setLoadError("");
    try {
      const [nextAgents, nextServers] = await Promise.all([api.agents(), api.mcpServers()]);
      const permissions = await Promise.all(nextServers.map(async (server) => [
        server.id, await api.resourceVisibility("mcp", server.id),
      ] as const));
      if (request !== loadRequest.current) return;
      setAgents(nextAgents);
      setServers(nextServers);
      setVisibility(Object.fromEntries(permissions));
    } catch (e) {
      if (request === loadRequest.current) setLoadError(`加载 MCP 配置失败：${(e as Error).message}`);
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    load();
    return () => { loadRequest.current += 1; toolsRequest.current += 1; };
  }, [load]);

  function setF(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  function parseEnv(text: string): Record<string, string> {
    const out: Record<string, string> = Object.create(null);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const idx = line.indexOf("=");
      const key = idx > 0 ? line.slice(0, idx).trim() : "";
      if (!key) throw new Error("环境变量或请求头必须每行填写 KEY=VALUE，请检查输入格式");
      out[key] = line.slice(idx + 1);
    }
    return out;
  }
  function envToText(env: Record<string, string> | undefined): string {
    return Object.entries(env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  }

  function openAdd() {
    setEditing(null);
    toolsRequest.current += 1;
    setRefreshing(false);
    setFormError("");
    setInvalidField(null);
    setForm(emptyForm);
    setTools([]);
    setTab("config");
    setOpen(true);
  }

  function openEdit(s: MCPServer) {
    setEditing(s);
    setFormError("");
    setInvalidField(null);
    setForm({
      name: s.name,
      transport: s.transport,
      command: s.command ?? "",
      args: JSON.stringify(s.args ?? [], null, 2),
      url: s.url ?? "",
      env: envToText(s.env),
      insecure: s.insecure ?? false,
    });
    setTab("config");
    setOpen(true);
    loadTools(s.id);
  }

  async function loadTools(id: number) {
    const request = ++toolsRequest.current;
    setRefreshing(false);
    setToolsLoading(true);
    setToolsError("");
    setTools([]);
    try {
      const result = await api.mcpTools(id);
      if (request === toolsRequest.current) setTools(result);
    } catch (e) {
      if (request === toolsRequest.current) setToolsError(`工具列表加载失败：${(e as Error).message}`);
    } finally {
      if (request === toolsRequest.current) setToolsLoading(false);
    }
  }

  function invalid(field: "name" | "command" | "url" | "args", message: string) {
    setInvalidField(field);
    setFormError(message);
    document.getElementById({ name: "m-name", command: "m-cmd", url: "m-url", args: "m-args" }[field])?.focus();
  }

  async function saveForm() {
    if (saving) return;
    setFormError("");
    setInvalidField(null);
    if (!form.name.trim()) return invalid("name", "请填写名称");
    if (form.transport === "stdio" && !form.command.trim()) return invalid("command", "请填写命令");
    if (form.transport !== "stdio" && !form.url.trim()) return invalid("url", "请填写远程 URL");
    let args: string[] = [];
    if (form.transport === "stdio") {
      try {
        const parsed: unknown = JSON.parse(form.args);
        if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) {
          return invalid("args", '参数必须是 JSON 字符串数组，例如 ["-y", "/path with space", ""]');
        }
        args = parsed;
      } catch {
        return invalid("args", "参数 JSON 格式无效。请使用双引号，并将路径中的反斜杠写为 \\\\。");
      }
    }
    setSaving(true);
    try {
      const base =
        form.transport !== "stdio"
          ? {
              transport: form.transport,
              url: form.url.trim(),
              command: "",
              args: [] as string[],
              env: parseEnv(form.env), // 远程模式下 env 即请求头
              insecure: form.insecure,
            }
          : {
              transport: "stdio" as const,
              command: form.command.trim(),
              args,
              env: parseEnv(form.env),
              insecure: false,
            };
      await api.saveMcpServer({
        ...(editing ? { id: editing.id } : {}),
        name: form.name.trim(),
        enabled: editing ? editing.enabled : true,
        ...base,
      });
      toast.success(editing ? "已保存" : "已添加 MCP 服务器");
      setOpen(false);
      load();
    } catch (e) {
      setFormError("保存失败：" + (e as Error).message);
      toast.error("保存失败：" + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function refreshTools() {
    if (!editing) return;
    const request = ++toolsRequest.current;
    setRefreshing(true);
    try {
      const t = await api.refreshMcpServer(editing.id);
      if (request !== toolsRequest.current) return;
      setTools(t);
      setToolsError("");
      toast.success(`发现 ${t.length} 个工具`);
      load();
    } catch (e) {
      toast.error("刷新失败：" + (e as Error).message);
    } finally {
      if (request === toolsRequest.current) setRefreshing(false);
    }
  }

  async function removeServer(s: MCPServer) {
    await api.deleteMcpServer(s.id);
    toast.success(`已删除：${s.name}`);
    if (editing?.id === s.id) setOpen(false);
    await load();
  }

  async function toggleEnabled(s: MCPServer) {
    if (updateLock.current) return;
    updateLock.current = true;
    setUpdating(true);
    try {
      await api.saveMcpServer({ ...s, enabled: !s.enabled });
      await load();
    } catch (e) {
      toast.error("操作失败：" + (e as Error).message);
    } finally {
      updateLock.current = false;
      setUpdating(false);
    }
  }

  async function toggleVisibility(serverId: number, agentId: string, agentName: string) {
    if (updateLock.current) return;
    updateLock.current = true;
    setUpdating(true);
    const on = (visibility[serverId] ?? []).includes(agentId);
    try {
      await api.toggleVisibility(agentId, "mcp", serverId, !on);
      toast.success(`${on ? "取消" : "授予"}「${agentName}」可见`);
      await load();
    } catch (e) {
      toast.error("操作失败：" + (e as Error).message);
    } finally {
      updateLock.current = false;
      setUpdating(false);
    }
  }

  function renderForm() {
    return (
      <fieldset disabled={saving} className="grid min-w-0 gap-4 py-4">
        <div className="grid gap-2">
          <p id="m-transport-label" className="text-sm font-medium">传输方式</p>
          <fieldset aria-labelledby="m-transport-label" className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={form.transport === "stdio" ? "default" : "outline"}
              aria-pressed={form.transport === "stdio"}
              onClick={() => setF({ transport: "stdio" })}
            >
              stdio（本地）
            </Button>
            <Button
              type="button"
              variant={form.transport === "http" ? "default" : "outline"}
              aria-pressed={form.transport === "http"}
              onClick={() => setF({ transport: "http" })}
            >
              http（远程）
            </Button>
            <Button
              type="button"
              variant={form.transport === "sse" ? "default" : "outline"}
              aria-pressed={form.transport === "sse"}
              onClick={() => setF({ transport: "sse" })}
            >
              sse（旧版）
            </Button>
          </fieldset>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="m-name">名称</Label>
          <Input
            id="m-name"
                aria-invalid={invalidField === "name"}
                aria-describedby={invalidField === "name" ? "m-form-error" : undefined}
            placeholder="filesystem"
            value={form.name}
            onChange={(e) => setF({ name: e.target.value })}
          />
        </div>
        {form.transport === "stdio" ? (
          <>
            <div className="grid gap-2">
              <Label htmlFor="m-cmd">命令</Label>
              <Input
                id="m-cmd"
                aria-invalid={invalidField === "command"}
                aria-describedby={invalidField === "command" ? "m-form-error" : undefined}
                className="font-mono"
                placeholder="npx"
                value={form.command}
                onChange={(e) => setF({ command: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="m-args">参数（JSON 字符串数组）</Label>
              <Textarea
                id="m-args"
                className="font-mono"
                rows={4}
                aria-invalid={invalidField === "args"}
                aria-describedby={`m-args-help${invalidField === "args" ? " m-form-error" : ""}`}
                placeholder={'["-y", "@modelcontextprotocol/server-filesystem", "/data"]'}
                value={form.args}
                onChange={(e) => setF({ args: e.target.value })}
              />
              <p id="m-args-help" className="text-xs text-muted-foreground">每项是一个完整参数，空格和空字符串会保留。无参数时填写 []。Windows 路径中的反斜杠需写为两个反斜杠。</p>
            </div>
          </>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="m-url">远程 URL</Label>
            <Input
              id="m-url"
                aria-invalid={invalidField === "url"}
                aria-describedby={invalidField === "url" ? "m-form-error" : undefined}
              className="font-mono"
              placeholder="https://mcp.example.com/mcp"
              value={form.url}
              onChange={(e) => setF({ url: e.target.value })}
            />
            <Label className="flex items-center gap-2 text-sm">
              <Checkbox
                aria-label="跳过 TLS 证书校验（自签证书）"
                checked={form.insecure}
                onCheckedChange={(v) => setF({ insecure: v === true })}
              />
              跳过 TLS 证书校验（自签证书）
            </Label>
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor="m-env">
            {form.transport !== "stdio"
              ? "请求头（每行 KEY=VALUE，如 Authorization=Bearer xxx）"
              : "环境变量（每行 KEY=VALUE）"}
          </Label>
          <Textarea
            id="m-env"
            className="font-mono"
            placeholder={
              form.transport !== "stdio" ? "Authorization=Bearer xxxx" : "API_KEY=xxxx\nFOO=bar"
            }
            value={form.env}
            onChange={(e) => setF({ env: e.target.value })}
          />
        </div>
        {formError && <p id="m-form-error" role="alert" className="text-sm text-destructive">{formError}</p>}
      </fieldset>
    );
  }

  function renderTools() {
    return (
      <div className="flex flex-col gap-3 py-4">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-sm">{tools.length} 个工具</span>
          <Button size="sm" variant="outline" disabled={refreshing || toolsLoading} onClick={refreshTools}>
            <RefreshCwIcon className={refreshing ? "animate-spin" : ""} /> 刷新
          </Button>
        </div>
        {toolsLoading ? (
          <p className="text-muted-foreground text-sm">加载中…</p>
        ) : toolsError ? (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>{toolsError}</p>
            <Button variant="outline" onClick={() => editing && loadTools(editing.id)}>重试加载工具列表</Button>
          </div>
        ) : tools.length === 0 ? (
          <p className="text-muted-foreground text-sm">尚未发现工具，点击刷新重新获取。</p>
        ) : (
          <div className="flex flex-col divide-y">
            {tools.map((t) => (
              <div key={t.name} className="py-2.5">
                <code className="font-mono text-sm">{t.name}</code>
                {t.description && (
                  <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                    {t.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 md:gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">MCP</h1>
        <p className="text-muted-foreground text-sm">外部 MCP 工具服务器 · 按 Agent 授权可见</p>
      </div>

      {loadError && <div role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive"><p>{loadError}</p><Button className="mt-2" variant="outline" onClick={load}>重试加载 MCP</Button></div>}
      {loading && <p role="status" className="text-sm text-muted-foreground">正在加载 MCP 配置…</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <button
          type="button"
          onClick={openAdd}
          className="text-foreground/70 border-foreground/70 hover:bg-muted/60 hover:shadow-sm flex min-h-[116px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed transition"
        >
          <PlusIcon className="size-6" />
          <span className="text-sm">添加 MCP</span>
        </button>

        {servers.map((s) => (
          <Card
            key={s.id}
            className="gap-3"
          >
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <ServerIcon className="text-muted-foreground size-4 shrink-0" />
                <CardTitle className="min-w-0 flex-1 text-base"><button type="button" className="max-w-full truncate text-left hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring" aria-label={`编辑 MCP ${s.name}`} disabled={loading || updating || !!loadError} onClick={() => openEdit(s)}>{s.name}</button></CardTitle>
                <Badge variant="outline" className="uppercase">
                  {s.transport}
                </Badge>
                <div className="ml-auto flex items-center gap-2">
                  <Switch
                    checked={s.enabled}
                    onCheckedChange={() => toggleEnabled(s)}
                    aria-label={`启用 MCP ${s.name}`}
                    disabled={updating || loading || !!loadError}
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={`删除 MCP ${s.name}`}
                    disabled={updating || loading || !!loadError}
                    onClick={() => setDeleteTarget(s)}
                  >
                    <Trash2Icon className="text-destructive" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p className="text-muted-foreground text-sm">
                {s.tools && s.tools.length > 0 ? `${s.tools.length} 个工具` : "尚未发现工具"}
              </p>
              <div className="grid gap-2">
                <span className="text-muted-foreground text-xs">可见性（按 Agent 授权）</span>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {agents.map((a) => (
                    <Label key={a.key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        aria-label={`授权 ${a.name} 使用 MCP ${s.name}`}
                        disabled={updating || loading || !!loadError}
                        checked={(visibility[s.id] ?? []).includes(a.id)}
                        onCheckedChange={() => toggleVisibility(s.id, a.id, a.name)}
                      />
                      {a.name}
                    </Label>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <ConfirmActionDialog
        open={!!deleteTarget}
        onOpenChange={(value) => { if (!value) setDeleteTarget(null); }}
        title="删除 MCP 服务器"
        description={`将永久删除 MCP「${deleteTarget?.name ?? ""}」及其 Agent 授权，相关工具将不再可用。此操作无法撤销。`}
        confirmLabel="永久删除"
        onConfirm={async () => { if (deleteTarget) await removeServer(deleteTarget); }}
      />
      <Sheet open={open} onOpenChange={(value) => { if (!saving) setOpen(value); }}>
        <SheetContent
          side="right"
          className="data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
        >
          <SheetHeader>
            <SheetTitle>{editing ? editing.name : "添加 MCP 服务器"}</SheetTitle>
            <SheetDescription>
              stdio（本地起进程）或 http（远程 Streamable HTTP）
            </SheetDescription>
          </SheetHeader>

          {editing ? (
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as "config" | "tools")}
              className="flex min-h-0 flex-1 flex-col px-4"
            >
              <TabsList>
                <TabsTrigger value="config">配置</TabsTrigger>
                <TabsTrigger value="tools">
                  工具列表{tools.length ? `（${tools.length}）` : ""}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="config" className="min-h-0 flex-1 overflow-y-auto">
                {renderForm()}
                <div className="flex gap-2 pt-2 pb-6">
                  <Button onClick={saveForm} disabled={saving}>
                    {saving ? "保存中…" : "保存"}
                  </Button>
                </div>
              </TabsContent>
              <TabsContent value="tools" className="min-h-0 flex-1 overflow-y-auto">
                {renderTools()}
              </TabsContent>
            </Tabs>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
              {renderForm()}
              <div className="pt-2 pb-6">
                <Button onClick={saveForm} disabled={saving}>
                  <PlusIcon /> {saving ? "保存中…" : "添加"}
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
