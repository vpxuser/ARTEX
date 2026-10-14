import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "工具执行 · ARTEX" };

export default function PageLayout({ children }: { children: ReactNode }) {
  return children;
}
