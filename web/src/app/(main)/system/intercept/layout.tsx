import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "拦截规则 · ARTEX" };

export default function PageLayout({ children }: { children: ReactNode }) {
  return children;
}
