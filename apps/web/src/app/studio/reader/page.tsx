import { Suspense } from "react";
import { DocumentReader } from "@/components/DocumentReader";

export const dynamic = "force-dynamic";

export default function ReaderPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-text-muted">Opening…</div>}>
      <DocumentReader />
    </Suspense>
  );
}
