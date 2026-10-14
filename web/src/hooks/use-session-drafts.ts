"use client";

import * as React from "react";

import type { ChatAttachment } from "@/lib/types";

export type SessionDraft = {
  text: string;
  attachments: ChatAttachment[];
  requestId: string;
  uploading?: boolean;
  sending?: boolean;
};

export type SessionDraftUpdate = Partial<SessionDraft> | ((draft: SessionDraft) => Partial<SessionDraft>);

const EMPTY_DRAFT: SessionDraft = { text: "", attachments: [], requestId: "", uploading: false, sending: false };

// Hold this store above a keyed conversation view so switching recipients keeps
// their drafts. Async callers capture the recipient key before uploading/sending.
export function useSessionDrafts(initialDrafts: Record<string, SessionDraft> = {}) {
  const [drafts, setDrafts] = React.useState(initialDrafts);
  const draftsRef = React.useRef(drafts);

  const getDraft = React.useCallback((key: string): SessionDraft => draftsRef.current[key] ?? EMPTY_DRAFT, []);

  const updateDraft = React.useCallback((key: string, update: SessionDraftUpdate) => {
    const current = draftsRef.current[key] ?? EMPTY_DRAFT;
    const patch = typeof update === "function" ? update(current) : update;
    const next = { ...draftsRef.current, [key]: { ...current, ...patch } };
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  const clearDraft = React.useCallback((key: string) => {
    const next = { ...draftsRef.current };
    const current = next[key];
    // Clearing sent content must not release an upload/send still in flight.
    // Its captured recipient's finally callback owns the corresponding flag.
    if (current?.uploading || current?.sending) {
      next[key] = { ...EMPTY_DRAFT, uploading: current.uploading ?? false, sending: current.sending ?? false };
    } else {
      delete next[key];
    }
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  return { drafts, getDraft, updateDraft, clearDraft };
}

export type SessionDraftStore = ReturnType<typeof useSessionDrafts>;
