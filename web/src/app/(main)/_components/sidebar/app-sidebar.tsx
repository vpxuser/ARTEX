"use client";

import { Suspense, useEffect, useState } from "react";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { ArrowLeft } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { getNavigationArea, isWorkspaceUrl } from "@/navigation/sidebar/navigation-utils";
import { systemSidebarItems, workspaceActionItems, workspaceSidebarItems } from "@/navigation/sidebar/sidebar-items";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

import { LayoutControls } from "./layout-controls";
import { NavMain } from "./nav-main";
import { ThemeSwitcher } from "./theme-switcher";

const WORKSPACE_LOCATION_KEY = "artex:last-workspace-url";

// Keep query parameters such as the selected conversation when returning from settings.
// This small Suspense boundary lets the surrounding sidebar remain visible during static export.
function WorkspaceLocationTracker({ onRestore }: { onRestore: (url: string) => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const query = searchParams.toString();
    const url = `${pathname}${query ? `?${query}` : ""}`;
    if (isWorkspaceUrl(url)) {
      onRestore(url);
      try {
        sessionStorage.setItem(WORKSPACE_LOCATION_KEY, url);
      } catch {
        // Returning still works in this tab when browser storage is unavailable.
      }
      return;
    }
    try {
      const saved = sessionStorage.getItem(WORKSPACE_LOCATION_KEY);
      if (saved && isWorkspaceUrl(saved)) onRestore(saved);
    } catch {
      // Use the default workspace entry if no previous location can be read.
    }
  }, [pathname, searchParams, onRestore]);

  return null;
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();
  const isSystem = getNavigationArea(pathname) === "system";
  const [workspaceHref, setWorkspaceHref] = useState("/chat");
  const { isMobile, setOpenMobile } = useSidebar();
  const { sidebarVariant, sidebarCollapsible, isSynced } = usePreferencesStore(
    useShallow((s) => ({
      sidebarVariant: s.sidebarVariant,
      sidebarCollapsible: s.sidebarCollapsible,
      isSynced: s.isSynced,
    })),
  );

  const variant = isSynced ? sidebarVariant : props.variant;
  const collapsible = isSynced ? sidebarCollapsible : props.collapsible;

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar role="navigation" aria-label={isSystem ? "系统导航" : "工作台导航"} {...props} variant={variant} collapsible={collapsible}>
      <Suspense fallback={null}>
        <WorkspaceLocationTracker onRestore={setWorkspaceHref} />
      </Suspense>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip={isSystem ? "系统设置" : "工作台"}>
              <Link prefetch={false} href={isSystem ? "/system/settings" : "/chat"} onClick={closeMobileSidebar}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logo.png" alt="ARTEX" width={32} height={32} className="shrink-0" />
                <span className="flex flex-col gap-0.5 group-data-[collapsible=icon]:sr-only">
                  <span className="font-semibold text-base">{APP_CONFIG.name}</span>
                  <span className="text-muted-foreground text-xs">{isSystem ? "系统设置" : "工作台"}</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {isSystem && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="返回工作台">
                <Link prefetch={false} href={workspaceHref} onClick={closeMobileSidebar}>
                  <ArrowLeft />
                  <span className="group-data-[collapsible=icon]:sr-only">返回工作台</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="group-data-[collapsible=icon]:overflow-y-auto group-data-[collapsible=icon]:overflow-x-hidden">
        <NavMain items={isSystem ? systemSidebarItems : workspaceSidebarItems} />
      </SidebarContent>
      <SidebarFooter className="border-t">
        {!isSystem && <NavMain items={workspaceActionItems} />}
        <div className="flex items-center justify-between gap-2 px-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:px-0">
          <span className="text-muted-foreground text-xs group-data-[collapsible=icon]:hidden">外观</span>
          <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
            <LayoutControls />
            <ThemeSwitcher />
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
