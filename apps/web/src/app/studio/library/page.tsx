import { Suspense } from "react";
import { LibraryView } from "@/components/LibraryView";

export const dynamic = "force-dynamic";

export default function LibraryPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-text-muted">Opening…</div>}>
      <LibraryView />
    </Suspense>
  );
}
