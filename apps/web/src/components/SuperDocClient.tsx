"use client";

import dynamic from "next/dynamic";
import { forwardRef, useMemo, type ComponentType } from "react";
import { SuperDocStyles } from "@/components/SuperDocStyles";
import { SUPERDOC_DEFAULT_PROPS } from "@/lib/superdocWorkers";

export type SuperDocInstance = {
  export: (opts: {
    exportType?: string[];
    triggerDownload?: boolean;
    exportedName?: string;
  }) => Promise<Blob | unknown>;
};

export type SuperDocEditorRef = {
  getInstance: () => SuperDocInstance | null;
};

type SuperDocEditorComponent = ComponentType<Record<string, unknown>>;

const SuperDocEditorInner = dynamic(
  () => import("@superdoc-dev/react").then((m) => m.SuperDocEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full min-h-[480px] items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-sm text-zinc-400">
        Loading SuperDoc editor…
      </div>
    ),
  },
) as unknown as SuperDocEditorComponent;

type Props = Record<string, unknown>;

/**
 * SuperDoc must never SSR. Always inject same-origin workerUrls for Next.js.
 */
export const SuperDocEditor = forwardRef<SuperDocEditorRef, Props>(
  function SuperDocEditor(props, ref) {
    const merged = useMemo(
      () => ({
        ...SUPERDOC_DEFAULT_PROPS,
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