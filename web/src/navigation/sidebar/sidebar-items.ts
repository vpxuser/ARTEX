import {
  Activity,
  Ban,
  BellRing,
  Bot,
  Brain,
  Bug,
  ClipboardList,
  FolderOpen,
  FolderSync,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  Network,
  Plug,
  Radio,
  ScrollText,
  Settings2,
  ShieldAlert,
  Sparkles,
  Target,
  Terminal,
  Wrench,
} from "lucide-react";

export type NavBadge = "new" | "soon";

export interface NavSubItem {
  id: string;
  title: string;
  url: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

interface NavItemBase {
  id: string;
  title: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

export interface NavMainLinkItem extends NavItemBase {
  url: string;
  subItems?: never;
}

export interface NavMainParentItem extends NavItemBase {
  subItems: NavSubItem[];
}

export type NavMainItem = NavMainLinkItem | NavMainParentItem;

export interface NavGroup {
  id: number;
  label?: string;
  items: NavMainItem[];
}

export const workspaceSidebarItems: NavGroup[] = [
  {
    id: 1,
    label: "工作台",
    items: [
      { id: "dashboard", title: "仪表盘", url: "/dashboard", icon: LayoutDashboard },
      { id: "chat", title: "对话", url: "/chat", icon: MessageSquare },
      { id: "tasks", title: "任务", url: "/function/tasks", icon: Target },
      { id: "findings", title: "发现", url: "/function/findings", icon: Bug },
      { id: "assets", title: "资产", url: "/function/assets", icon: Network },
      { id: "sync", title: "资产同步", url: "/function/sync", icon: FolderSync },
      { id: "workspace", title: "工作空间", url: "/function/workspace", icon: FolderOpen },
    ],
  },
  {
    id: 2,
    label: "执行记录",
    items: [
      { id: "traffic", title: "流量", url: "/function/traffic", icon: Activity },
      { id: "commands", title: "工具执行", url: "/function/commands", icon: Terminal },
      { id: "llm-records", title: "模型调用记录", url: "/function/llm-records", icon: Radio },
    ],
  },
];

export const workspaceActionItems: NavGroup[] = [
  {
    id: 3,
    items: [
      { id: "approvals", title: "待审批", url: "/system/intercept/approvals", icon: ClipboardList },
      { id: "system-settings", title: "系统设置", url: "/system/settings", icon: Settings2 },
    ],
  },
];

export const systemSidebarItems: NavGroup[] = [
  {
    id: 4,
    label: "模型与能力",
    items: [
      { id: "llm", title: "LLM", url: "/system/llm", icon: Brain },
      { id: "agents", title: "Agent", url: "/system/agents", icon: Bot },
      { id: "mcp", title: "MCP", url: "/system/mcp", icon: Plug },
      { id: "skills", title: "Skill", url: "/system/skills", icon: Sparkles },
      { id: "tools", title: "工具", url: "/system/tools", icon: Wrench },
    ],
  },
  {
    id: 5,
    label: "安全与集成",
    items: [
      { id: "intercept", title: "拦截规则", url: "/system/intercept", icon: ShieldAlert },
      { id: "asset-intercept", title: "资产拦截", url: "/system/intercept/assets", icon: Ban },
      { id: "approvals", title: "审批记录", url: "/system/intercept/approvals", icon: ClipboardList },
      { id: "notify", title: "通知推送", url: "/system/notify", icon: BellRing },
    ],
  },
  {
    id: 6,
    label: "运行维护",
    items: [
      { id: "logs", title: "系统日志", url: "/system/logs", icon: ScrollText },
      { id: "settings", title: "系统配置", url: "/system/settings", icon: Settings2 },
    ],
  },
];
