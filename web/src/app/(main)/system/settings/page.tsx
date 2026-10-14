"use client";

import * as React from "react";

import { CpuIcon, FlaskConicalIcon, KeyboardIcon, RadioTowerIcon, SearchIcon, ShieldAlertIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { CHAT_SEND_MODE_OPTIONS, type ChatSendMode, setChatSendMode, useChatSendMode } from "@/lib/chat-send-mode";
import type { Settings } from "@/lib/types";

import { UpdateCard } from "./_components/update-card";

function SettingsDescription({ summary, children, id }: { summary: string; children: React.ReactNode; id?: string }) {
  return (
    <CardDescription className="leading-relaxed">
      <p id={id}>{summary}</p>
      <details className="mt-2">
        <summary className="w-fit cursor-pointer rounded-sm text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          详细说明
        </summary>
        <div className="mt-2 space-y-2 text-xs leading-relaxed">{children}</div>
      </details>
    </CardDescription>
  );
}

function DraftStatus({ id, dirty, saved }: { id: string; dirty: boolean; saved: string }) {
  return (
    <p
      id={id}
      role="status"
      className={dirty ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}
    >
      {dirty ? "有未保存更改，点击保存后生效" : saved}
    </p>
  );
}

export default function SystemSettingsPage() {
  const [trafficCapture, setTrafficCapture] = React.useState(false);
  const [agentTrafficBinding, setAgentTrafficBinding] = React.useState(false);
  const [webSearch, setWebSearch] = React.useState(false);
  const [backend, setBackend] = React.useState("ddgs");
  const [braveKeySet, setBraveKeySet] = React.useState(false);
  const [braveKeyInput, setBraveKeyInput] = React.useState("");
  const [tavilyKeySet, setTavilyKeySet] = React.useState(false);
  const [tavilyKeyInput, setTavilyKeyInput] = React.useState("");
  const [proxyInput, setProxyInput] = React.useState("");
  const [globalProxyInput, setGlobalProxyInput] = React.useState("");
  const [testing, setTesting] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState("");
  const [saveError, setSaveError] = React.useState("");
  const [savedGlobalProxy, setSavedGlobalProxy] = React.useState("");
  const [savedProxy, setSavedProxy] = React.useState("");
  const [savedPython, setSavedPython] = React.useState("");
  const [savedWorkers, setSavedWorkers] = React.useState("3");
  const savingRef = React.useRef(false);
  const loadRequest = React.useRef(0);
  const [saving, setSaving] = React.useState(false);
  const [pyInterp, setPyInterp] = React.useState("");
  const [workers, setWorkers] = React.useState("3");
  // 操作约束注入范围(默认都开)。
  const [injectPlanner, setInjectPlanner] = React.useState(true);
  const [injectWorker, setInjectWorker] = React.useState(true);
  // 实验功能:noa 上下文压缩(默认关)。
  const [noaCompaction, setNoaCompaction] = React.useState(false);
  // 纯前端偏好：不走 /api/settings，直接读写 localStorage。
  const sendMode = useChatSendMode();

  // Server-confirmed state and editable drafts have separate lifecycles. A save
  // for one card must never replace another card's unsaved inputs.
  const apply = React.useCallback((s: Settings, initializeDrafts = false) => {
    setTrafficCapture(!!s.traffic_capture);
    setAgentTrafficBinding(!!s.agent_traffic_binding);
    setWebSearch(!!s.web_search_enabled);
    setBackend(s.web_search_backend || "ddgs");
    setBraveKeySet(!!s.brave_key_set);
    setTavilyKeySet(!!s.tavily_key_set);
    setSavedGlobalProxy(s.global_proxy ?? "");
    setSavedProxy(s.web_search_proxy ?? "");
    setSavedPython(s.python_interpreter ?? "");
    setSavedWorkers(String(s.workers ?? 3));
    setInjectPlanner(s.constraints_inject_planner !== false);
    setInjectWorker(s.constraints_inject_worker !== false);
    setNoaCompaction(!!s.noa_compaction);
    if (initializeDrafts) {
      setProxyInput(s.web_search_proxy ?? "");
      setGlobalProxyInput(s.global_proxy ?? "");
      setPyInterp(s.python_interpreter ?? "");
      setWorkers(String(s.workers ?? 3));
    }
  }, []);

  const load = React.useCallback(async () => {
    const request = ++loadRequest.current;
    setLoaded(false);
    setLoadError("");
    try {
      const settings = await api.settings();
      if (request !== loadRequest.current) return;
      apply(settings, true);
      setLoaded(true);
    } catch (e) {
      if (request === loadRequest.current) setLoadError(`配置加载失败：${(e as Error).message}`);
    }
  }, [apply]);

  React.useEffect(() => {
    void load();
    return () => {
      loadRequest.current += 1;
    };
  }, [load]);

  async function saveSettings(patch: Partial<Settings>, message: string, reconcileDraft?: (s: Settings) => void) {
    // Serialize writes so an older response cannot replace a newer saved state.
    if (!loaded || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const s = await api.setSettings(patch);
      apply(s);
      reconcileDraft?.(s);
      toast.success(message);
    } catch (e) {
      const message = `保存失败：${(e as Error).message}`;
      setSaveError(message);
      toast.error(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const saveWorkers = () => {
    const snapshot = workers;
    const n = Number(snapshot);
    if (!Number.isInteger(n) || n <= 0) {
      setSaveError("并发数必须是大于 0 的整数");
      toast.error("并发数必须是大于 0 的整数");
      return;
    }
    void saveSettings({ workers: n }, "已保存并发工作 agent 数（对之后启动的任务生效）", (s) => {
      setWorkers((current) => (current === snapshot ? String(s.workers ?? 3) : current));
    });
  };

  const savePython = () => {
    const snapshot = pyInterp;
    void saveSettings({ python_interpreter: snapshot.trim() }, "已保存 Python 解释器配置", (s) => {
      setPyInterp((current) => (current === snapshot ? (s.python_interpreter ?? "") : current));
    });
  };

  const detectPython = async () => {
    if (!loaded || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const r = await api.detectPython();
      setPyInterp(r.python_interpreter);
      setSavedPython(r.python_interpreter);
      toast.success("已重新检测并保存 Python 解释器配置");
    } catch (e) {
      const message = `检测失败：${(e as Error).message}`;
      setSaveError(message);
      toast.error(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const toggleTraffic = (v: boolean) => saveSettings({ traffic_capture: v }, "已保存流量捕获配置");
  const toggleInjectPlanner = (v: boolean) =>
    saveSettings({ constraints_inject_planner: v }, "已保存规划者操作约束配置");
  const toggleInjectWorker = (v: boolean) => saveSettings({ constraints_inject_worker: v }, "已保存执行者操作约束配置");
  const toggleAgentTrafficBinding = (v: boolean) =>
    saveSettings({ agent_traffic_binding: v }, v ? "已开启 Agent 自动绑定流量" : "已关闭 Agent 自动绑定流量");
  const toggleNoaCompaction = (v: boolean) =>
    saveSettings(
      { noa_compaction: v },
      v ? "已开启 noa 上下文压缩（对之后启动的运行生效）" : "已关闭 noa 上下文压缩（恢复内置压缩）",
    );
  const saveWebSearch = (patch: Partial<Settings>) => saveSettings(patch, "已保存网络搜索配置");

  const saveBraveKey = () => {
    const snapshot = braveKeyInput;
    void saveSettings({ brave_search_api_key: snapshot }, "已保存 Brave API 密钥", () => {
      setBraveKeyInput((current) => (current === snapshot ? "" : current));
    });
  };
  const saveTavilyKey = () => {
    const snapshot = tavilyKeyInput;
    void saveSettings({ tavily_search_api_key: snapshot }, "已保存 Tavily API 密钥", () => {
      setTavilyKeyInput((current) => (current === snapshot ? "" : current));
    });
  };
  const saveProxy = () => {
    const snapshot = proxyInput;
    void saveSettings(
      { web_search_proxy: snapshot.trim() },
      snapshot.trim() ? "已保存出口代理" : "已清除出口代理（改为直连）",
      (s) => {
        setProxyInput((current) => (current === snapshot ? (s.web_search_proxy ?? "") : current));
      },
    );
  };
  const saveGlobalProxy = () => {
    const snapshot = globalProxyInput;
    void saveSettings(
      { global_proxy: snapshot.trim() },
      snapshot.trim() ? "已保存全局代理" : "已清除全局代理（改为直连）",
      (s) => {
        setGlobalProxyInput((current) => (current === snapshot ? (s.global_proxy ?? "") : current));
      },
    );
  };

  // Run a real "test" search ("test") against the CURRENT form values (backend +
  // proxy + entered key), falling back to saved values server-side. Toasts result.
  const runTest = () => {
    setTesting(true);
    api
      .testWebSearch({
        web_search_backend: backend,
        web_search_proxy: proxyInput.trim(),
        brave_search_api_key: braveKeyInput,
        tavily_search_api_key: tavilyKeyInput,
      })
      .then((r) => {
        if (r.ok) toast.success(`搜索测试成功 · ${r.backend} 返回 ${r.count} 条结果`);
        else toast.error("搜索测试失败：" + (r.error || "未知错误"));
      })
      .catch((e) => toast.error("搜索测试失败：" + (e as Error).message))
      .finally(() => setTesting(false));
  };

  if (!loaded) {
    return (
      <div className="flex flex-1 flex-col gap-4">
        <h1 className="text-xl font-semibold tracking-tight">系统配置</h1>
        {loadError ? (
          <div role="alert" className="rounded-lg border border-destructive/50 p-4">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button className="mt-3" variant="outline" onClick={load}>
              重试加载配置
            </Button>
          </div>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            正在加载配置…
          </p>
        )}
      </div>
    );
  }

  // brave-free selected but no key stored and none being entered → tool stays off.
  const braveNeedsKey = webSearch && backend === "brave-free" && !braveKeySet;

  return (
    <div className="flex flex-1 flex-col gap-4 md:gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">系统配置</h1>
        <p className="text-muted-foreground text-sm">管理运行能力、网络连接与个人偏好</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          开关和下拉选择自动保存；输入框修改后需点击对应的「保存」。状态以服务器确认结果为准。
        </p>
      </div>

      {saveError && (
        <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
          {saveError}
        </p>
      )}
      {saving && (
        <p role="status" className="text-sm text-muted-foreground">
          正在保存配置，生效状态将在服务器确认后更新…
        </p>
      )}

      <div className="grid items-start gap-4 md:gap-6 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <RadioTowerIcon className="size-4" />
              流量捕获
            </CardTitle>
            <SettingsDescription summary="记录 Agent 的 HTTP 请求和响应，便于回溯测试过程。">
              开启后，所有 Agent 的 HTTP 流量经记录代理全量落库，并向 Agent 注入 traffic_search / traffic_get
              工具与代理配置（提示词含代理说明）。
              <br />
              关闭（默认）时不记录任何流量：Agent
              <b>不会</b>拿到代理配置与流量工具，提示词也<b>不含</b>代理相关内容。切换后会即时重建 Agent 生效。
            </SettingsDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <Label htmlFor="traffic-capture" className="text-sm font-normal text-muted-foreground">
              {trafficCapture ? "已开启 · 正在记录流量并注入代理" : "已关闭 · 不记录、不注入代理"}
            </Label>
            <Switch
              id="traffic-capture"
              checked={trafficCapture}
              disabled={!loaded || saving}
              onCheckedChange={toggleTraffic}
            />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <RadioTowerIcon className="size-4" />
              Agent 自动绑定流量
            </CardTitle>
            <SettingsDescription
              id="agent-traffic-binding-description"
              summary="让报告自动关联已有流量证据；开启后可能增加 Token 消耗。"
            >
              默认关闭。开启后，漏洞入库时触发的报告 Agent 会核对已有 HTTP 请求/响应，关联对应流量后再编写报告。
              <b>查阅数据包及额外的工具调用会增加 Token 消耗。</b>
              <br />
              TCP、未抓包或没有匹配流量时仍可正常上报。此开关不影响流量捕获、人工绑定及已保存证据的查看。 对下一轮 Agent
              生效；关闭后会立即拒绝新的自动绑定。
            </SettingsDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <Label htmlFor="agent-traffic-binding" className="text-sm font-normal text-muted-foreground">
              {agentTrafficBinding ? "已开启 · 会增加 Token 消耗" : "已关闭 · 可继续人工绑定"}
            </Label>
            <Switch
              id="agent-traffic-binding"
              aria-describedby="agent-traffic-binding-description"
              checked={agentTrafficBinding}
              disabled={!loaded || saving}
              onCheckedChange={toggleAgentTrafficBinding}
            />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <RadioTowerIcon className="size-4" />
              全局代理
            </CardTitle>
            <SettingsDescription summary="为目标流量设置统一出口。留空直连；与搜索代理、模型代理分别配置。">
              所有 Agent 的<b>目标流量</b>经此代理出网（隐藏源 IP / 走跳板）。支持 <b>http / https / socks5</b>，可带{" "}
              <code>user:pass</code> 认证。留空=直连。
              <br />
              开启<b>流量捕获</b>时，它作为记录代理的<b>上游</b>（流量仍全量落库，再经此代理出网）；关闭捕获时，直接注入
              Agent 的 bash / WebFetch 出网。与网络搜索代理、LLM 代理相互独立。
              <br />
              <b>提示</b>：socks5 在<b>关闭捕获</b>时依赖各命令行工具对 <code>ALL_PROXY</code> 的支持（curl
              可用，部分工具可能忽略）； 若主要用 socks5，建议开启流量捕获——此路径由 MITM
              亲自拨号，工具无感知、稳定生效。
            </SettingsDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Label htmlFor="global-proxy" className="text-sm font-normal text-muted-foreground">
              代理地址
            </Label>
            <div className="flex items-center gap-2">
              <Input
                aria-describedby="global-proxy-status"
                id="global-proxy"
                autoComplete="off"
                placeholder="socks5://user:pass@host:1080 或 http://host:port（留空=直连）"
                value={globalProxyInput}
                disabled={!loaded || saving}
                onChange={(e) => setGlobalProxyInput(e.target.value)}
              />
              <Button type="button" aria-label="保存全局代理" onClick={saveGlobalProxy} disabled={!loaded || saving}>
                保存
              </Button>
            </div>
            <p id="global-proxy-status" role="status" className="text-muted-foreground text-xs">
              {savedGlobalProxy.trim()
                ? "已保存 · 目标流量使用全局代理配置（各工具的支持范围见上方说明）"
                : "已保存 · 未配置全局代理，目标流量直连出网"}
              {globalProxyInput.trim() !== savedGlobalProxy.trim() && (
                <span className="block font-medium text-foreground">有未保存更改，尚未生效</span>
              )}
            </p>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlertIcon className="size-4" />
              操作约束注入
            </CardTitle>
            <SettingsDescription summary="将任务中设置的允许和禁止事项提供给规划者、执行者。">
              开启后，把每个任务的<b>操作约束</b>（在任务总览「操作约束」里维护的允许/禁止条目）拼进对应 Agent
              的系统提示，用来框定探索边界（如「仅测当前端口」「禁止爆破」）。
              <br />
              可分别控制注入到 <b>规划者（planner）</b>与 <b>执行者（worker）</b>
              ；默认都开。切换即时生效（下一轮读取），无需重建 Agent。关闭后该 Agent 不再看到约束。
            </SettingsDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <Label htmlFor="inject-planner" className="text-sm font-normal text-muted-foreground">
                注入规划者（planner）{injectPlanner ? " · 已开启" : " · 已关闭"}
              </Label>
              <Switch
                id="inject-planner"
                checked={injectPlanner}
                disabled={!loaded || saving}
                onCheckedChange={toggleInjectPlanner}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <Label htmlFor="inject-worker" className="text-sm font-normal text-muted-foreground">
                注入执行者（worker）{injectWorker ? " · 已开启" : " · 已关闭"}
              </Label>
              <Switch
                id="inject-worker"
                checked={injectWorker}
                disabled={!loaded || saving}
                onCheckedChange={toggleInjectWorker}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConicalIcon className="size-4" />
              实验功能
            </CardTitle>
            <SettingsDescription summary="尝试由模型压缩长对话历史。默认关闭，可能影响运行行为与稳定性。">
              尚在验证中的机制，默认关闭。可能改变 Agent 行为或影响稳定性，请在了解影响后启用。
              <br />
              <b>noa 上下文压缩</b>：由模型主动压缩长对话历史（norma v0.4.0）。开启后平台接入的四类 Agent（
              <b>规划者 / 执行者 / 主 Agent / 对话</b>）改用 noa 接管上下文，取代内置压缩，
              压缩原文会归档到任务工作目录下便于回溯。切换即时生效（对之后启动的运行生效），无需重建 Agent；
              关闭后立即恢复内置压缩。
            </SettingsDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <Label htmlFor="noa-compaction" className="text-sm font-normal text-muted-foreground">
              noa 上下文压缩{noaCompaction ? " · 已开启" : " · 已关闭"}
            </Label>
            <Switch
              id="noa-compaction"
              checked={noaCompaction}
              disabled={!loaded || saving}
              onCheckedChange={toggleNoaCompaction}
            />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SearchIcon className="size-4" />
              网络搜索
            </CardTitle>
            <SettingsDescription summary="为 Agent 启用联网搜索，并选择搜索来源。部分来源需要密钥或额外费用。">
              这是网络搜索的<b>总开关 + 来源配置</b>。开启后，才能在<b>每个 Agent 的配置</b>里单独选择是否启用
              <b>web_search</b>（仅返回标题/链接/摘要，不抓取正文；抓取由 WebFetch 负责）。网络搜索<b>不走</b>
              记录代理，独立于流量捕获。
              <br />
              来源可选 <b>DuckDuckGo（ddgs）</b>（无需密钥）、<b>Brave（免费版）</b>（需填写 Brave API 密钥）、{" "}
              <b>Tavily</b>（需填写 Tavily API 密钥）或 <b>DeepSeek</b>（复用当前 LLM 配置）。总开关关闭时，各 Agent
              的网络搜索开关不可用。
            </SettingsDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <Label htmlFor="web-search" className="text-sm font-normal text-muted-foreground">
                {webSearch ? "总开关已开启 · 可在各 Agent 配置里单独启用" : "已关闭 · 各 Agent 无法启用网络搜索"}
              </Label>
              <Switch
                id="web-search"
                checked={webSearch}
                disabled={!loaded || saving}
                onCheckedChange={(v) => {
                  saveWebSearch({ web_search_enabled: v });
                }}
              />
            </div>

            {webSearch && (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <Label htmlFor="search-backend" className="text-sm font-normal text-muted-foreground">
                  搜索来源
                </Label>
                <Select
                  value={backend}
                  disabled={!loaded || saving}
                  onValueChange={(v) => {
                    saveWebSearch({ web_search_backend: v });
                  }}
                >
                  <SelectTrigger id="search-backend" className="w-48 max-w-full">
                    <SelectValue placeholder="选择来源" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ddgs">DuckDuckGo（免费）</SelectItem>
                    <SelectItem value="brave-free">Brave（免费版 · 需密钥）</SelectItem>
                    <SelectItem value="tavily">Tavily（需密钥）</SelectItem>
                    <SelectItem value="deepseek">DeepSeek（官方）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {webSearch && backend === "deepseek" && (
              <div className="border-border/60 bg-muted/30 flex flex-col gap-2 rounded-md border p-3">
                <p className="text-sm font-medium">DeepSeek 官方联网搜索</p>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  该来源直接复用<b>当前激活的 LLM 配置</b>。因此它
                  <b>仅支持 DeepSeek 官方模型</b>，且该配置<b>必须使用 anthropic 协议</b>
                  ——DeepSeek 的 OpenAI 协议端点不支持服务端搜索。切换 LLM 配置后此来源可能失效。
                </p>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  与其它来源不同，搜索由 <b>DeepSeek 服务端执行</b>：每次搜索会额外消耗一次模型调用（产生 Token
                  费用），搜索请求<b>不经过上面的出口代理</b>，也<b>不计入流量留痕</b>；返回结果<b>只有标题和链接</b>
                  （无摘要），需要正文时由 WebFetch 抓取。
                </p>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  是否满足上述条件由你自行确认，系统不做拦截；可用下方「测试搜索」按钮实际跑一次来验证。
                </p>
              </div>
            )}

            {webSearch && backend === "brave-free" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="brave-key" className="text-sm font-normal text-muted-foreground">
                  Brave Search API 密钥
                  {braveKeySet && <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-400">已配置</span>}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="brave-key"
                    aria-describedby="brave-key-status"
                    type="password"
                    autoComplete="off"
                    placeholder={braveKeySet ? "已配置（留空则不变）" : "输入 Brave API 密钥"}
                    value={braveKeyInput}
                    disabled={!loaded || saving}
                    onChange={(e) => setBraveKeyInput(e.target.value)}
                  />
                  <Button
                    type="button"
                    onClick={saveBraveKey}
                    disabled={!loaded || saving || braveKeyInput.trim() === ""}
                  >
                    保存
                  </Button>
                </div>
                <DraftStatus
                  id="brave-key-status"
                  dirty={braveKeyInput.trim() !== ""}
                  saved={braveKeySet ? "已保存 · 已配置密钥" : "尚未配置密钥"}
                />
                {braveNeedsKey && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    已选择 Brave 但尚未配置密钥，保存密钥之前，搜索工具不会启用。
                  </p>
                )}
                <p className="text-muted-foreground text-xs">
                  免费版额度约 2,000 次/月。前往 https://brave.com/search/api/ 获取密钥。
                </p>
              </div>
            )}

            {webSearch && backend === "tavily" && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="tavily-key" className="text-sm font-normal text-muted-foreground">
                  Tavily Search API 密钥
                  {tavilyKeySet && <span className="ml-2 text-xs text-emerald-700 dark:text-emerald-400">已配置</span>}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="tavily-key"
                    aria-describedby="tavily-key-status"
                    type="password"
                    autoComplete="off"
                    placeholder={tavilyKeySet ? "已配置（留空则不变）" : "输入 Tavily API 密钥（tvly-…）"}
                    value={tavilyKeyInput}
                    disabled={!loaded || saving}
                    onChange={(e) => setTavilyKeyInput(e.target.value)}
                  />
                  <Button
                    type="button"
                    onClick={saveTavilyKey}
                    disabled={!loaded || saving || tavilyKeyInput.trim() === ""}
                  >
                    保存
                  </Button>
                </div>
                <DraftStatus
                  id="tavily-key-status"
                  dirty={tavilyKeyInput.trim() !== ""}
                  saved={tavilyKeySet ? "已保存 · 已配置密钥" : "尚未配置密钥"}
                />
                {webSearch && backend === "tavily" && !tavilyKeySet && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    已选择 Tavily 但尚未配置密钥，保存密钥之前，搜索工具不会启用。
                  </p>
                )}
                <p className="text-muted-foreground text-xs">前往 https://tavily.com 注册并获取 API 密钥。</p>
              </div>
            )}

            {webSearch && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="ws-proxy" className="text-sm font-normal text-muted-foreground">
                  出口代理（可选）
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="ws-proxy"
                    aria-describedby="search-proxy-status"
                    autoComplete="off"
                    placeholder="http://host:port 或 socks5://host:port（留空=直连）"
                    value={proxyInput}
                    disabled={!loaded || saving}
                    onChange={(e) => setProxyInput(e.target.value)}
                  />
                  <Button type="button" aria-label="保存搜索代理" onClick={saveProxy} disabled={!loaded || saving}>
                    保存
                  </Button>
                </div>
                <DraftStatus
                  id="search-proxy-status"
                  dirty={proxyInput.trim() !== savedProxy.trim()}
                  saved={savedProxy ? "已保存 · 搜索使用独立出口代理" : "已保存 · 搜索直接连接"}
                />
                <p className="text-muted-foreground text-xs">
                  独立出口代理，仅用于访问搜索端点（VPN/SOCKS 等）。与记录流量的 MITM 代理无关；网络不通时经此代理访问。
                </p>
              </div>
            )}

            {webSearch && (
              <div className="flex items-center justify-between gap-4 border-t pt-4">
                <p className="text-muted-foreground text-xs">
                  用当前配置（来源 + 代理 + 密钥）实际搜索一次「test」，验证是否可用。
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={runTest}
                  disabled={!loaded || saving || testing}
                  className="shrink-0"
                >
                  {testing ? "测试中…" : "测试搜索"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <RadioTowerIcon className="size-4" />
              自定义脚本 · Python 解释器
            </CardTitle>
            <SettingsDescription summary="选择自定义脚本使用的 Python 环境。留空时自动检测。">
              自定义<b>脚本工具</b>使用它运行 Python。启动时会自动检测（python3 优先）；此处可填写虚拟环境或
              特定版本的绝对路径，留空则运行时自动检测。
            </SettingsDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Label htmlFor="python-interpreter">Python 解释器路径</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="python-interpreter"
                aria-describedby="python-status"
                className="min-w-0 basis-full font-mono text-sm sm:flex-1 sm:basis-0"
                placeholder="/usr/bin/python3（留空=自动检测）"
                value={pyInterp}
                disabled={!loaded || saving}
                onChange={(e) => setPyInterp(e.target.value)}
              />
              <Button variant="outline" onClick={detectPython} disabled={!loaded || saving}>
                重新检测
              </Button>
              <Button aria-label="保存 Python 解释器" onClick={savePython} disabled={!loaded || saving}>
                保存
              </Button>
            </div>
            <DraftStatus
              id="python-status"
              dirty={pyInterp.trim() !== savedPython.trim()}
              saved={savedPython ? "已保存 · 使用指定的 Python 环境" : "已保存 · 自动检测 Python 环境"}
            />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CpuIcon className="size-4" />
              工作并发 · Work Agent 数
            </CardTitle>
            <SettingsDescription summary="设置每个新任务的并发执行数量；提高并发也会增加资源消耗。">
              每个任务并发运行的工作 agent 数量（默认 3）。数值越大并发探测越多、消耗也越高。修改后
              <b>对之后启动的任务生效</b>，正在运行的任务不受影响。
            </SettingsDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Label htmlFor="worker-count">并发工作 Agent 数</Label>
            <div className="flex items-center gap-2">
              <Input
                id="worker-count"
                aria-describedby="workers-status"
                type="number"
                min={1}
                className="w-32 font-mono text-sm"
                placeholder="3"
                value={workers}
                disabled={!loaded || saving}
                onChange={(e) => setWorkers(e.target.value)}
              />
              <Button aria-label="保存工作并发" onClick={saveWorkers} disabled={!loaded || saving}>
                保存
              </Button>
            </div>
            <DraftStatus
              id="workers-status"
              dirty={workers !== savedWorkers}
              saved={`已保存 · 新任务并发数为 ${savedWorkers}`}
            />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyboardIcon className="size-4" />
              会话输入框发送键位
            </CardTitle>
            <SettingsDescription summary="设置当前浏览器的消息发送快捷键，选择后立即生效。">
              对话页与任务详情的主 Agent 会话输入框共用此设置，选择后立即生效、无需保存。
              <br />
              该偏好<b>只存在本浏览器</b>，不随账号同步，换浏览器或清理站点数据后需重新设置。
            </SettingsDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <Label htmlFor="chat-send-mode" className="text-sm font-normal text-muted-foreground">
              发送方式
            </Label>
            <Select value={sendMode} onValueChange={(v) => setChatSendMode(v as ChatSendMode)}>
              <SelectTrigger id="chat-send-mode" className="w-full max-w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHAT_SEND_MODE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <div className="lg:col-span-2 [&>[data-slot=card]]:mb-0">
          <UpdateCard />
        </div>
      </div>
    </div>
  );
}
