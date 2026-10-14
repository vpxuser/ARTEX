"use client";

import * as React from "react";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { getActiveNavUrl } from "@/navigation/sidebar/navigation-utils";
import type {
  NavBadge,
  NavGroup,
  NavMainItem,
  NavMainLinkItem,
  NavMainParentItem,
} from "@/navigation/sidebar/sidebar-items";

interface NavMainProps {
  readonly items: readonly NavGroup[];
}
interface NavItemProps {
  readonly item: NavMainItem;
  readonly isItemActive: (item: NavMainItem) => boolean;
  readonly isSubItemActive: (url: string) => boolean;
  readonly isSubmenuOpen: (item: NavMainParentItem) => boolean;
}

interface NavLinkItemProps {
  readonly item: NavMainLinkItem;
  readonly isActive: boolean;
  readonly showIconFallback: boolean;
}

interface NavLinkIconProps {
  readonly item: NavMainLinkItem;
  readonly showFallback: boolean;
}

interface NavDropdownItemProps {
  readonly item: NavMainParentItem;
  readonly isActive: boolean;
  readonly isSubItemActive: (url: string) => boolean;
}

interface NavCollapsibleItemProps {
  readonly item: NavMainParentItem;
  readonly isActive: boolean;
  readonly defaultOpen: boolean;
  readonly isSubItemActive: (url: string) => boolean;
}

function CollapsedIconFallback({ title }: { title: string }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-xs font-medium text-[10px] outline">
      {title.slice(0, 1)}
    </span>
  );
}

function hasSubItems(item: NavMainItem): item is NavMainParentItem {
  return Boolean(item.subItems?.length);
}

export function NavMain({ items }: NavMainProps) {
  const path = usePathname();
  const urls = items.flatMap((group) =>
    group.items.flatMap((item) => (hasSubItems(item) ? item.subItems.map((sub) => sub.url) : [item.url])),
  );
  const activeUrl = getActiveNavUrl(path, urls);

  const isItemActive = (item: NavMainItem) => {
    if (hasSubItems(item)) {
      return item.subItems.some((sub) => sub.url === activeUrl);
    }

    return item.url === activeUrl;
  };

  const isSubItemActive = (url: string) => {
    return url === activeUrl;
  };

  const isSubmenuOpen = (item: NavMainParentItem) => {
    return item.subItems.some((sub) => sub.url === activeUrl);
  };

  return (
    <>
      {items.map((group) => (
        <SidebarGroup key={group.id} className="group-data-[collapsible=icon]:px-0">
          {group.label && (
            <SidebarGroupLabel className="group-data-[collapsible=icon]:pointer-events-none">
              {group.label}
            </SidebarGroupLabel>
          )}
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => (
                <NavItem
                  key={item.id}
                  item={item}
                  isItemActive={isItemActive}
                  isSubItemActive={isSubItemActive}
                  isSubmenuOpen={isSubmenuOpen}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

function NavItem({ item, isItemActive, isSubItemActive, isSubmenuOpen }: NavItemProps) {
  const { state, isMobile } = useSidebar();
  const isCollapsedDesktop = state === "collapsed" && !isMobile;

  if (!hasSubItems(item)) {
    return <NavLinkItem item={item} isActive={isItemActive(item)} showIconFallback={isCollapsedDesktop} />;
  }

  if (isCollapsedDesktop) {
    return <NavDropdownItem item={item} isActive={isItemActive(item)} isSubItemActive={isSubItemActive} />;
  }

  return (
    <NavCollapsibleItem
      item={item}
      isActive={isItemActive(item)}
      defaultOpen={isSubmenuOpen(item)}
      isSubItemActive={isSubItemActive}
    />
  );
}

// InterceptPendingBadge polls /api/intercept/pending every 5 s and shows a count
// count badge when there are unresolved approval requests.
function InterceptPendingBadge() {
  const [count, setCount] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    async function poll() {
      try {
        const list = await api.interceptPending();
        if (live) setCount(list.length);
      } catch {
        // Keep the last known count when polling temporarily fails.
      }
    }
    void poll();
    const t = setInterval(() => void poll(), 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (count === 0) return null;
  return (
    <SidebarMenuBadge
      aria-label={`${count} 个待审批请求`}
      aria-live="polite"
      className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1 font-semibold text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200 leading-none shadow-sm ring-1 ring-amber-400/40"
    >
      {count > 99 ? "99+" : count}
    </SidebarMenuBadge>
  );
}

function NavLinkItem({ item, isActive, showIconFallback }: NavLinkItemProps) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild aria-disabled={item.disabled} tooltip={item.title} isActive={isActive}>
        <Link
          prefetch={false}
          href={item.url}
          target={item.newTab ? "_blank" : undefined}
          rel={item.newTab ? "noreferrer" : undefined}
          aria-current={isActive ? "page" : undefined}
          onClick={(event) => {
            if (item.disabled) event.preventDefault();
            else if (isMobile) setOpenMobile(false);
          }}
        >
          <NavLinkIcon item={item} showFallback={showIconFallback} />
          <span className="group-data-[collapsible=icon]:sr-only">{item.title}</span>
        </Link>
      </SidebarMenuButton>
      {item.id === "approvals" ? <InterceptPendingBadge /> : <NavItemBadge badge={item.badge} />}
    </SidebarMenuItem>
  );
}

function NavLinkIcon({ item, showFallback }: NavLinkIconProps) {
  const Icon = item.icon;

  if (Icon) {
    return <Icon />;
  }

  if (showFallback) {
    return <CollapsedIconFallback title={item.title} />;
  }

  return null;
}

function NavDropdownItem({ item, isActive, isSubItemActive }: NavDropdownItemProps) {
  const Icon = item.icon;
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton tooltip={item.title} isActive={isActive} disabled={item.disabled}>
            {Icon ? <Icon /> : <CollapsedIconFallback title={item.title} />}
            <span className="group-data-[collapsible=icon]:sr-only">{item.title}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>

        <DropdownMenuContent side="right" align="start" sideOffset={12} className="w-48">
          <DropdownMenuGroup>
            {item.subItems.map((subItem) => {
              const SubIcon = subItem.icon;

              return (
                <DropdownMenuItem key={subItem.id} asChild disabled={subItem.disabled}>
                  <Link
                    prefetch={false}
                    href={subItem.url}
                    target={subItem.newTab ? "_blank" : undefined}
                    rel={subItem.newTab ? "noreferrer" : undefined}
                    aria-current={isSubItemActive(subItem.url) ? "page" : undefined}
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                    className="flex items-center gap-2"
                  >
                    {SubIcon && <SubIcon />}
                    <span>{subItem.title}</span>
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function NavCollapsibleItem({ item, isActive, defaultOpen, isSubItemActive }: NavCollapsibleItemProps) {
  const Icon = item.icon;
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <Collapsible asChild defaultOpen={defaultOpen} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.title} isActive={isActive} disabled={item.disabled}>
            {Icon && <Icon />}
            <span className="group-data-[collapsible=icon]:sr-only">{item.title}</span>
            <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <NavItemBadge badge={item.badge} />

        <CollapsibleContent>
          <SidebarMenuSub>
            {item.subItems.map((subItem) => {
              const SubIcon = subItem.icon;

              return (
                <SidebarMenuSubItem key={subItem.id}>
                  <SidebarMenuSubButton
                    asChild
                    aria-disabled={subItem.disabled}
                    isActive={isSubItemActive(subItem.url)}
                  >
                    <Link
                      prefetch={false}
                      href={subItem.url}
                      target={subItem.newTab ? "_blank" : undefined}
                      rel={subItem.newTab ? "noreferrer" : undefined}
                      aria-current={isSubItemActive(subItem.url) ? "page" : undefined}
                      onClick={(event) => {
                        if (subItem.disabled) event.preventDefault();
                        else if (isMobile) setOpenMobile(false);
                      }}
                    >
                      {SubIcon && <SubIcon />}
                      <span>{subItem.title}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function NavItemBadge({ badge }: { badge?: NavBadge }) {
  if (!badge) {
    return null;
  }

  return (
    <SidebarMenuBadge
      className={cn(
        "rounded-sm border capitalize",
        badge === "new" &&
          "border-green-600 text-green-600 peer-hover/menu-button:text-green-600 peer-data-active/menu-button:text-green-600",
        badge === "soon" && "border-muted-foreground text-muted-foreground",
      )}
    >
      {badge}
    </SidebarMenuBadge>
  );
}
