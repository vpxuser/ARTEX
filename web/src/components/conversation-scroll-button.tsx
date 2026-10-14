"use client";

import { ArrowDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export function ConversationScrollButton({
  hasNewActivity,
  onClick,
}: {
  hasNewActivity: boolean;
  onClick: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="pointer-events-auto rounded-full bg-background shadow-md"
        onClick={onClick}
      >
        <ArrowDownIcon data-icon="inline-start" />
        {hasNewActivity ? "有新活动 · 回到最新" : "回到最新"}
      </Button>
    </div>
  );
}
