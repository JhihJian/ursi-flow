import { Suspense } from "react";
import { LiveRoot } from "./live/LiveRoot";

export default function Home() {
  return (
    <Suspense>
      <LiveRoot />
    </Suspense>
  );
}
