"use client";

import { type ReactNode, useEffect, useState } from "react";

import { usePathname } from "next/navigation";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useCurrentUser } from "@/hooks/use-current-user";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { getNavigationArea } from "@/navigation/sidebar/navigation-utils";

import { AccountSwitcher } from "./sidebar/account-switcher";
import { SearchDialog } from "./sidebar/search-dialog";
import { UpdateBadge } from "./update-badge";

// Task detail owns its task context and inner padding; the global header remains shared.
function isTaskDetail(pathname: string) {
  return pathname.replace(/\/+$/, "") === "/function/tasks/detail";
}

export function MainContent({ children }: { children: ReactNode }) {
  const currentUser = useCurrentUser();
  const pathname = usePathname();
  const isSystem = getNavigationArea(pathname) === "system";
  const [version, setVersion] = useState("");

  useEffect(() => {
    api
      .health()
      .then((h) => setVersion((h.version ?? "").replace(/^v(?=\d)/, "")))
      .catch(() => setVersion(""));
  }, []);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 rounded-t-[inherit] border-b bg-background/95 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-4 lg:px-6">
          <div className="flex items-center gap-1 lg:gap-2">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center"
            />
            <span className="hidden font-medium text-sm sm:inline">{isSystem ? "系统设置" : "工作台"}</span>
            <SearchDialog />
          </div>
          <div className="flex items-center gap-2">
            {isSystem && version && (
              <span className="hidden font-medium text-muted-foreground text-xs tabular-nums md:inline">
                版本 · {version}
              </span>
            )}
            {isSystem && <UpdateBadge />}
            <AccountSwitcher user={currentUser} />
          </div>
        </div>
      </header>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden",
          isTaskDetail(pathname)
            ? "flex flex-col"
            : "p-4 has-data-[content-padding=false]:p-0 md:p-6 md:has-data-[content-padding=false]:p-0",
        )}
      >
        {children}
      </div>
    </>
  );
}
