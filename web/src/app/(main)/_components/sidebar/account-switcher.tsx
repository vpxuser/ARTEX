"use client";

import { useState } from "react";

import { KeyRound, LogOut } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { auth, type CurrentUser } from "@/lib/auth";
import { getInitials } from "@/lib/utils";

import { ChangePasswordDialog } from "./change-password-dialog";

export function AccountSwitcher({ user }: { readonly user: CurrentUser }) {
  const [pwOpen, setPwOpen] = useState(false);
  const roleLabel =
    ({ operator: "操作员", admin: "管理员", user: "用户", member: "成员" } as Record<string, string>)[user.role] ??
    user.role;

  function handleLogout() {
    auth.clearToken();
    window.location.href = "/login";
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-9 rounded-lg" aria-label={`账户菜单：${user.name}`}>
            <Avatar className="size-8 rounded-lg">
              <AvatarImage src={user.avatar || undefined} alt="" />
              <AvatarFallback>{getInitials(user.name)}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-56 rounded-lg" side="bottom" align="end" sideOffset={4}>
          <DropdownMenuLabel className="flex items-center gap-2 px-2 py-2 font-normal">
            <Avatar className="size-9 rounded-lg">
              <AvatarImage src={user.avatar || undefined} alt="" />
              <AvatarFallback>{getInitials(user.name)}</AvatarFallback>
            </Avatar>
            <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold">{user.name}</span>
              {user.email && <span className="truncate text-muted-foreground text-xs">{user.email}</span>}
              <span className="truncate text-muted-foreground text-xs capitalize">{roleLabel}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setPwOpen(true)}>
            <KeyRound />
            修改密码
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
            <LogOut />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </>
  );
}
