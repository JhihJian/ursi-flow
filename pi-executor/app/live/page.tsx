import type { Metadata } from "next";
import { LiveRoot } from "./LiveRoot";

export const metadata: Metadata = { title: "Pi Web · 实时会话" };

export default function LivePage() {
  return <LiveRoot />;
}
