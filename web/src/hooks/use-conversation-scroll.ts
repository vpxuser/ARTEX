"use client";

import * as React from "react";

type ConversationScrollOptions = {
  contentRef: React.RefObject<HTMLDivElement | null>;
  atBottomRef: React.MutableRefObject<boolean>;
  viewport: () => HTMLElement | null;
  sessionKey: string | number;
  activity: unknown;
  latestSeq: number;
  paused: boolean;
  blockHistory: boolean;
  onReachTop: () => void;
};

// Keep live output visible, including lazy Markdown/detail expansion, without
// moving readers who have scrolled into history or followed an approval source.
export function useConversationScroll({
  contentRef,
  atBottomRef,
  viewport,
  sessionKey,
  activity,
  latestSeq,
  paused,
  blockHistory,
  onReachTop,
}: ConversationScrollOptions) {
  const [isAtBottom, setIsAtBottom] = React.useState(true);
  const [hasNewActivity, setHasNewActivity] = React.useState(false);
  const previousSeq = React.useRef(latestSeq);

  const holdPosition = React.useCallback(() => {
    atBottomRef.current = false;
    setIsAtBottom(false);
  }, [atBottomRef]);

  const jumpToLatest = React.useCallback(() => {
    const vp = viewport();
    if (!vp) return;
    atBottomRef.current = true;
    vp.scrollTop = vp.scrollHeight;
    setIsAtBottom(true);
    setHasNewActivity(false);
  }, [viewport, atBottomRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: switching sessions resets the live edge; pausing does not reset the session.
  React.useLayoutEffect(() => {
    previousSeq.current = latestSeq;
    setHasNewActivity(false);
    if (paused) {
      atBottomRef.current = false;
      setIsAtBottom(false);
    } else {
      jumpToLatest();
    }
  }, [sessionKey, jumpToLatest]);

  React.useLayoutEffect(() => {
    if (!paused) return;
    atBottomRef.current = false;
    setIsAtBottom(false);
  }, [paused, atBottomRef]);

  // Older pages are prepended with the same latest sequence, so they never count
  // as new activity. Initial history loads do not produce a notification either.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activity changes include streamed replacements as well as new steps.
  React.useLayoutEffect(() => {
    if (latestSeq > previousSeq.current && previousSeq.current > 0 && !atBottomRef.current) {
      setHasNewActivity(true);
    }
    previousSeq.current = latestSeq;
    if (!paused && atBottomRef.current) jumpToLatest();
  }, [activity, latestSeq, paused, jumpToLatest, atBottomRef]);

  React.useEffect(() => {
    const vp = viewport();
    if (!vp) return;
    let previousTop = vp.scrollTop;
    const onScroll = () => {
      const movingUp = vp.scrollTop < previousTop;
      previousTop = vp.scrollTop;
      const readingEarlier = movingUp && vp.scrollTop <= 80 && vp.scrollHeight - vp.clientHeight > 60;
      const atBottom = !readingEarlier && vp.scrollHeight - vp.scrollTop - vp.clientHeight <= 60;
      atBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
      if (atBottom) setHasNewActivity(false);
      if (!blockHistory && readingEarlier) onReachTop();
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, [viewport, atBottomRef, blockHistory, onReachTop]);

  React.useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const onInspect = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const toggle = target?.closest('button[aria-expanded="false"], [data-tool-inspect], summary');
      if (!toggle || !content.contains(toggle)) return;
      if (toggle.tagName === "SUMMARY" && toggle.parentElement?.hasAttribute("open")) return;
      // Opening execution details is an explicit reading action. Keep its
      // position while lazy output arrives instead of following the live edge.
      holdPosition();
    };
    content.addEventListener("click", onInspect, true);
    return () => content.removeEventListener("click", onInspect, true);
  }, [contentRef, holdPosition]);

  React.useEffect(() => {
    const content = contentRef.current;
    const vp = viewport();
    if (!content || !vp || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!paused && atBottomRef.current) jumpToLatest();
      });
    });
    observer.observe(content);
    observer.observe(vp);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [contentRef, viewport, paused, atBottomRef, jumpToLatest]);

  return { isAtBottom, hasNewActivity, holdPosition, jumpToLatest };
}
