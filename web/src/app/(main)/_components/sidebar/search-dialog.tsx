"use client";

import * as React from "react";

import { usePathname, useRouter } from "next/navigation";

import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useSidebar } from "@/components/ui/sidebar";
import { getNavigationArea, type NavigationArea } from "@/navigation/sidebar/navigation-utils";
import {
  type NavGroup,
  type NavMainItem,
  systemSidebarItems,
  workspaceActionItems,
  workspaceSidebarItems,
} from "@/navigation/sidebar/sidebar-items";

type SearchItem = {
  id: string;
  area: NavigationArea;
  group: string;
  label: string;
  url: string;
  icon?: NavMainItem["icon"];
  disabled?: boolean;
  newTab?: boolean;
};

const areaLabels: Record<NavigationArea, string> = { workspace: "工作台", system: "系统设置" };

function getSearchItems(groups: NavGroup[], area: NavigationArea): SearchItem[] {
  return groups.flatMap((group) =>
    group.items.flatMap((item) => {
      const links = item.subItems ?? ("url" in item ? [item] : []);
      return links.map((link) => ({
        id: link.id,
        area,
        group: group.label ?? areaLabels[area],
        label: link.title,
        url: link.url,
        icon: link.icon ?? item.icon,
        disabled: link.disabled,
        newTab: link.newTab,
      }));
    }),
  );
}

const searchItems = [
  ...getSearchItems(workspaceSidebarItems, "workspace"),
  ...getSearchItems(
    workspaceActionItems.map((group) => ({ ...group, items: group.items.filter((item) => item.id === "approvals") })),
    "workspace",
  ),
  ...getSearchItems(systemSidebarItems, "system"),
].filter((item) => !item.disabled && !item.url.includes("coming-soon"));

function groupBy(items: SearchItem[]) {
  const groupTitle = (item: SearchItem) =>
    item.group === areaLabels[item.area] ? item.group : `${areaLabels[item.area]} · ${item.group}`;
  const groups = [...new Set(items.map(groupTitle))];
  return groups.map((group) => ({
    group,
    items: items.filter((item) => groupTitle(item) === group),
  }));
}

export function SearchDialog() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const pathname = usePathname();
  const area = getNavigationArea(pathname);
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const recommendations = searchItems.filter((item) => item.area === area);

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "j" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setQuery("");
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const handleOpenChange = (value: boolean) => {
    setOpen(value);
    if (!value) setQuery("");
  };

  const handleSelect = (item: SearchItem) => {
    if (item.disabled) return;
    handleOpenChange(false);
    if (isMobile) setOpenMobile(false);
    if (item.newTab) {
      window.open(item.url, "_blank", "noopener,noreferrer");
    } else {
      router.push(item.url);
    }
  };

  const renderGroups = (items: SearchItem[]) =>
    groupBy(items).map(({ group, items: groupItems }, index) => (
      <React.Fragment key={group}>
        {index > 0 && <CommandSeparator />}
        <CommandGroup heading={group}>
          {groupItems.map((item) => (
            <CommandItem
              disabled={item.disabled}
              key={`${item.area}-${item.id}`}
              value={`${areaLabels[item.area]} ${item.group} ${item.label}`}
              keywords={item.id === "llm-records" ? ["LLM", "录制"] : undefined}
              onSelect={() => handleSelect(item)}
            >
              <span className="flex min-w-0 items-center gap-2">
                {item.icon && <item.icon />}
                <span className="truncate">{item.label}</span>
              </span>
              {item.area !== area && (
                <span className="ml-auto text-muted-foreground text-xs">{areaLabels[item.area]}</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </React.Fragment>
    ));

  return (
    <>
      <Button
        onClick={() => handleOpenChange(true)}
        variant="link"
        className="px-0! font-normal text-muted-foreground hover:no-underline"
        aria-label="搜索导航（Ctrl 或 Command 加 J）"
      >
        <Search data-icon="inline-start" />
        搜索
        <kbd className="hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-medium text-[10px] sm:inline-flex">
          Ctrl / ⌘ J
        </kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={handleOpenChange}
        title="搜索导航"
        description="默认显示当前区域，输入关键词可搜索工作台和系统设置。"
      >
        <Command>
          <CommandInput
            placeholder="搜索任务、对话或系统设置…"
            value={query}
            onValueChange={setQuery}
            aria-label="搜索工作台与系统设置"
          />
          <CommandList>
            <CommandEmpty>未找到相关入口。</CommandEmpty>
            {query.trim() ? renderGroups(searchItems) : renderGroups(recommendations)}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
