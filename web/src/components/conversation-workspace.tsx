import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// The application sidebar and inspectors also consume width. Choose the list
// layout from the workspace width, keeping the same conversation tree mounted.
export function ConversationWorkspace({ children, listOpen }: { children: ReactNode; listOpen: boolean }) {
  return (
    <div data-conversation-workspace className="@container/conversations flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div
        className={cn(
          "grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden rounded-xl border bg-background @min-[56rem]/conversations:grid-cols-[16rem_minmax(0,1fr)] @min-[56rem]/conversations:grid-rows-[minmax(0,1fr)]",
          listOpen ? "grid-rows-[minmax(0,40svh)_minmax(0,1fr)]" : "grid-rows-[auto_minmax(0,1fr)]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export const conversationReadingClassName =
  "mx-auto w-full min-w-0 max-w-3xl px-3 py-6 @min-[28rem]/conversation:px-4 @min-[36rem]/conversation:px-6";
