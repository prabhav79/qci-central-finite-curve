"use client";

import dynamic from "next/dynamic";
import { forwardRef, useMemo, type ComponentType } from "react";
import { SuperDocStyles } from "@/components/SuperDocStyles";
import { SUPERDOC_DEFAULT_PROPS } from "@/lib/superdocWorkers";

export type SuperDocReplaceResult = { ok: boolean; reason?: string; detail?: string };

export type SuperDocInstance = {
  export: (opts: {
    exportType?: string[];
    triggerDownload?: boolean;
    exportedName?: string;
  }) => Promise<Blob | unknown>;
  replaceDocument?: (source: File | Blob) => Promise<SuperDocReplaceResult>;
};

export type SuperDocEditorRef = {
  getInstance: () => SuperDocInstance | null;
};

type SuperDocEditorComponent = ComponentType<Record<string, unknown>>;

const SKELETON_LINES = ["w-full", "w-11/12", "w-full", "w-4/5", "w-full", "w-3/4"];

/** Themed stand-in for the editor while SuperDoc's code and the document load:
 * a blank page on the desk, matching what replaces it. */
export function DocumentSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading document"
      className="flex h-full min-h-[320px] w-full justify-center overflow-hidden bg-surface-sunken px-4 pt-14"
    >
      <div className="h-[560px] w-full max-w-[640px] rounded-sm bg-white px-10 py-12 shadow-md">
        <div className="h-6 w-2/3 animate-pulse rounded bg-black/10" />
        <div className="mt-8 space-y-3">
          {SKELETON_LINES.map((w, i) => (
            <div key={i} className={`h-3 ${w} animate-pulse rounded bg-black/[0.06]`} />
          ))}
        </div>
        <div className="mt-8 h-4 w-1/3 animate-pulse rounded bg-black/10" />
        <div className="mt-4 space-y-3">
          {SKELETON_LINES.slice(0, 4).map((w, i) => (
            <div key={i} className={`h-3 ${w} animate-pulse rounded bg-black/[0.06]`} />
          ))}
        </div>
        <span className="sr-only">Loading document…</span>
      </div>
    </div>
  );
}

const SuperDocEditorInner = dynamic(
  () => import("@superdoc-dev/react").then((m) => m.SuperDocEditor),
  {
    ssr: false,
    loading: () => <DocumentSkeleton />,
  },
) as unknown as SuperDocEditorComponent;

type Props = Record<string, unknown>;

function renderLoading() {
  return <DocumentSkeleton />;
}

/**
 * SuperDoc must never SSR. Always inject same-origin workerUrls for Next.js.
 */
export const SuperDocEditor = forwardRef<SuperDocEditorRef, Props>(
  function SuperDocEditor(props, ref) {
    const merged = useMemo(
      () => ({
        ...SUPERDOC_DEFAULT_PROPS,
        renderLoading,
        ...props,
        workerUrls:
          (props.workerUrls as object | undefined) ??
          SUPERDOC_DEFAULT_PROPS.workerUrls,
        telemetry:
          (props.telemetry as object | undefined) ??
          SUPERDOC_DEFAULT_PROPS.telemetry,
        ref,
      }),
      [props, ref],
    );

    return (
      <>
        <SuperDocStyles />
        <SuperDocEditorInner {...merged} />
      </>
    );
  },
);
