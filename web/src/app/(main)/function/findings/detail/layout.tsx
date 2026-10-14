import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "发现详情 · ARTEX" };

export default function PageLayout({ children }: { children: ReactNode }) {
  return children;
}
