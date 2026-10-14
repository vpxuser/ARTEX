import type { ReactNode } from "react";

// Conversation and task sessions share the reading width and input surface.
export function ConversationComposer({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pt-2 pb-3 leading-normal @min-[28rem]/conversation:px-4 @min-[36rem]/conversation:px-6 @min-[36rem]/conversation:pb-4">
      <div className="rounded-2xl border bg-background p-3 shadow-xs transition-colors focus-within:border-ring/50">
        {children}
      </div>
    </div>
  );
}

export function ConversationComposerToolbar({ children }: { children: ReactNode }) {
  return <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">{children}</div>;
}
