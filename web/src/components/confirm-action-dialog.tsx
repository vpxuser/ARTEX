"use client";

import { useRef, useState } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** The caller throws on failure; keep the object and error visible for retry. */
export function ConfirmActionDialog({ open, onOpenChange, title, description, onConfirm, confirmLabel = "确认删除" }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => Promise<void>;
  confirmLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  async function confirm() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请重试");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return <AlertDialog open={open} onOpenChange={(next) => { if (!pending.current) { setError(""); onOpenChange(next); } }}>
    <AlertDialogContent aria-busy={busy}
      onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={(event) => { if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); } }}
      onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription className="break-words">{description}</AlertDialogDescription>
      </AlertDialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
        <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>{busy ? "处理中…" : confirmLabel}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
