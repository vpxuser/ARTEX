"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type SourceStatus = {
  label: string;
  data: unknown;
  loading: boolean;
  error: boolean;
  updatedAt: number | null;
  refresh: () => void;
};

// Each source retains its own last successful value and update time. A failing
// endpoint cannot prevent unrelated panels from receiving their next result.
export function useDashboardSource<T>(label: string, fetcher: () => Promise<T>, interval: number) {
  const [state, setState] = React.useState<{
    data: T | undefined;
    loading: boolean;
    error: boolean;
    updatedAt: number | null;
  }>({ data: undefined, loading: true, error: false, updatedAt: null });
  const loadRef = React.useRef<() => void>(() => {});
  const refresh = React.useCallback(() => loadRef.current(), []);

  React.useEffect(() => {
    let alive = true;
    let inFlight = false;
    let signature = "";
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      setState((previous) => ({ ...previous, loading: true }));
      try {
        const data = await fetcher();
        if (!alive) return;
        const nextSignature = JSON.stringify(data);
        const unchanged = nextSignature === signature;
        signature = nextSignature;
        setState((previous) => ({
          data: unchanged ? previous.data : data,
          loading: false,
          error: false,
          updatedAt: Date.now(),
        }));
      } catch {
        if (alive) setState((previous) => ({ ...previous, loading: false, error: true }));
      } finally {
        inFlight = false;
      }
    };
    loadRef.current = () => {
      void load();
    };
    void load();
    const timer = setInterval(load, interval);
    return () => {
      alive = false;
      clearInterval(timer);
      loadRef.current = () => {};
    };
  }, [fetcher, interval]);

  return { ...state, label, refresh };
}

export function DataState({
  sources,
  children,
  compact = false,
  className,
}: {
  sources: SourceStatus[];
  children: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const missing = sources.filter((source) => source.data === undefined);
  const failed = sources.filter((source) => source.error);
  if (missing.length > 0) {
    const missingFailures = missing.filter((source) => source.error);
    return (
      <div className={cn("min-w-0 py-3", className)} aria-busy={missingFailures.length === 0}>
        {missingFailures.length > 0 ? (
          <div className="space-y-2 text-xs">
            <p className="font-medium">{missingFailures.map((source) => source.label).join("、")}加载失败</p>
            {!compact && <p className="text-muted-foreground">暂时无法获取数据，请检查服务连接后重试。</p>}
            <Button
              variant="outline"
              size="sm"
              disabled={missingFailures.some((source) => source.loading)}
              onClick={() => missingFailures.forEach((source) => source.refresh())}
            >
              重试
            </Button>
          </div>
        ) : (
          <div role="status" className="space-y-3">
            <p className="text-xs text-muted-foreground">正在加载{missing.map((source) => source.label).join("、")}…</p>
            <div aria-hidden="true" className="h-5 w-2/3 animate-pulse rounded bg-muted" />
            {!compact && <div aria-hidden="true" className="h-5 w-1/2 animate-pulse rounded bg-muted" />}
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      {failed.length > 0 && (
        <div
          className={cn(
            "mb-3 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs",
            compact && "mx-4 mt-3",
          )}
        >
          {failed.map((source) => (
            <p key={source.label}>
              {source.label}刷新失败，保留{" "}
              {source.updatedAt ? new Date(source.updatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "上次"}{" "}
              更新的数据。
            </p>
          ))}
          <button
            type="button"
            onClick={() => failed.forEach((source) => source.refresh())}
            disabled={failed.some((source) => source.loading)}
            className="mt-1 inline-flex min-h-7 items-center rounded-sm font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {failed.some((source) => source.loading) ? "正在重试" : "重试"}
          </button>
        </div>
      )}
      {children}
    </>
  );
}
