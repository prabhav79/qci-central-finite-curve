"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type AgentFrame, type PersonaKey, type ServerLlm, errorText, streamAgentChat } from "@/lib/cfcApi";
import { type LlmChoice, agentRequestFields, choiceReady, missingKeyMessage } from "@/lib/llmChoice";
import { ModelPicker } from "@/components/ModelPicker";

type SectionStatus = "pending" | "running" | "done" | "failed";

type SectionState = {
  label: string;
  title: string;
  status: SectionStatus;
  startedAt?: number;
  endedAt?: number;
  error?: string | null;
};

type Run = {
  kind: "generate" | "chat";
  startedAt: number;
  endedAt?: number;
  stopped?: boolean;
};

type Flag = { section: string; claim: string };

type Summary = { generated: number; failed: string[] };

const FATAL_CODES = new Set(["auth", "quota"]);

export type AgentAutoRun = { preset: string; prompt: string; choice?: LlmChoice };

function toolLine(name: string): string {
  switch (name) {
    case "cfc_search_corpus":
      return "Searching past documents…";
    case "cfc_get_document":
      return "Reading a reference document…";
    case "cfc_read_current_draft":
      return "Reading the current document…";
    case "cfc_propose_insert":
      return "Writing to the document…";
    case "cfc_propose_replace":
      return "Updating the document…";
    case "cfc_propose_redline":
      return "Suggesting a change…";
    default:
      return "Working…";
  }
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-agent/25 border-t-agent"
    />
  );
}

function SectionIcon({ status }: { status: SectionStatus }) {
  if (status === "running") return <Spinner />;
  if (status === "done") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5 shrink-0 text-status-approved-text">
        <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <span
        aria-hidden
        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-status-rejected-text text-[10px] font-bold leading-none text-surface-raised"
      >
        !
      </span>
    );
  }
  return <span aria-hidden className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-border-strong" />;
}

export function AgentPanel({
  draftId,
  persona,
  superdocRole,
  canRunAgent,
  choice,
  onChoiceChange,
  serverLlm,
  isAdmin,
  onDraftUpdated,
  onThreadsChanged,
  onStreamingChange,
  autoRun,
  onAutoRunConsumed,
}: {
  draftId: string | undefined;
  persona: PersonaKey;
  /** "suggester" sessions are always routed server-side into the
   * suggestions-only path; this prop only changes the wording here. */
  superdocRole?: string;
  canRunAgent: boolean;
  choice: LlmChoice;
  onChoiceChange: (next: LlmChoice) => void;
  serverLlm: ServerLlm | null | undefined;
  isAdmin: boolean;
  onDraftUpdated?: (version: number) => void | Promise<void>;
  onThreadsChanged?: () => void;
  onStreamingChange?: (streaming: boolean) => void;
  /** Starts a preset as soon as the draft is ready (generation right after
   * the intake questions). Carries its own provider choice so the first
   * request doesn't depend on a state update landing first. */
  autoRun?: AgentAutoRun | null;
  onAutoRunConsumed?: () => void;
}) {
  const isReviewer = superdocRole === "suggester";
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [sections, setSections] = useState<SectionState[]>([]);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [reply, setReply] = useState("");
  const [details, setDetails] = useState<string[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const detailsRef = useRef<HTMLOListElement | null>(null);
  // draft_generator emits one draft_updated per section; collapse bursts to
  // at most one editor refresh per window and always flush the last version.
  const draftUpdateRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; pendingVersion: number | null }>({
    timer: null,
    pendingVersion: null,
  });

  useEffect(() => {
    onStreamingChange?.(streaming);
  }, [streaming, onStreamingChange]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      onStreamingChange?.(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [streaming]);

  useEffect(() => {
    if (detailsOpen && detailsRef.current) {
      detailsRef.current.scrollTop = detailsRef.current.scrollHeight;
    }
  }, [details, detailsOpen]);

  const keyReady = choiceReady(choice);
  const canSend = !!draftId && !!prompt.trim() && !streaming && keyReady;

  const send = useCallback(
    async (preset?: string, promptOverride?: string, choiceOverride?: LlmChoice): Promise<void> => {
      if (!draftId) return;
      const effectivePrompt = (promptOverride ?? prompt).trim();
      if (!effectivePrompt) return;
      const effectiveChoice = choiceOverride ?? choice;
      if (!choiceReady(effectiveChoice)) {
        setError(missingKeyMessage(effectiveChoice));
        return;
      }
      const kind: Run["kind"] = preset === "draft_generator" ? "generate" : "chat";
      const sectionList: SectionState[] = [];
      let currentSection: string | null = null;
      const note = (line: string) => setDetails((d) => [...d, line]);
      const publishSections = () => setSections([...sectionList]);

      setStreaming(true);
      setRun({ kind, startedAt: Date.now() });
      setNow(Date.now());
      setSections([]);
      setFlags([]);
      setSummary(null);
      setReply("");
      setDetails([]);
      setError(null);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await streamAgentChat(
          draftId,
          persona,
          {
            prompt: effectivePrompt,
            ...agentRequestFields(effectiveChoice),
            preset,
          },
          (frame: AgentFrame) => {
            switch (frame.type) {
              case "preset":
                if (frame.sections?.length) {
                  const initial = frame.sections.map((s) => ({
                    label: s.label,
                    title: s.title,
                    status: "pending" as const,
                  }));
                  sectionList.splice(0, sectionList.length, ...initial);
                  publishSections();
                  note(`Planning a ${initial.length}-section draft`);
                }
                break;
              case "token":
              case "text":
                if (kind === "chat") setReply((s) => s + frame.text);
                break;
              case "tool_call":
                note(toolLine(frame.name));
                break;
              case "tool_result": {
                const errMsg = (frame.result as { error?: string }).error;
                if (errMsg) note("One step didn't complete; continuing.");
                if (frame.name === "cfc_propose_redline" && !errMsg) onThreadsChanged?.();
                break;
              }
              case "draft_updated": {
                note("Document updated");
                const ref = draftUpdateRef.current;
                if (ref.timer) {
                  ref.pendingVersion = frame.version;
                  break;
                }
                void onDraftUpdated?.(frame.version);
                const tick = () => {
                  ref.timer = null;
                  if (ref.pendingVersion == null) return;
                  const v = ref.pendingVersion;
                  ref.pendingVersion = null;
                  void onDraftUpdated?.(v);
                  ref.timer = setTimeout(tick, 1500);
                };
                ref.timer = setTimeout(tick, 1500);
                break;
              }
              case "section_start": {
                currentSection = frame.section;
                let idx = sectionList.findIndex((s) => s.label === frame.section);
                if (idx === -1) {
                  sectionList.push({ label: frame.section, title: frame.title, status: "pending" });
                  idx = sectionList.length - 1;
                }
                sectionList[idx] = { ...sectionList[idx], title: frame.title, status: "running", startedAt: Date.now() };
                publishSections();
                note(`Writing section ${idx + 1} of ${sectionList.length}: ${frame.title}…`);
                break;
              }
              case "section_result": {
                const idx = sectionList.findIndex((x) => x.label === frame.section);
                const title = idx === -1 ? frame.section : sectionList[idx].title;
                const updated: SectionState = {
                  ...(idx === -1 ? { label: frame.section, title } : sectionList[idx]),
                  status: frame.ok ? "done" : "failed",
                  endedAt: Date.now(),
                  error: frame.ok ? null : frame.error ?? null,
                };
                if (idx === -1) sectionList.push(updated);
                else sectionList[idx] = updated;
                publishSections();
                if (currentSection === frame.section) currentSection = null;
                note(frame.ok ? `Finished “${title}”` : `Couldn't write “${title}”`);
                break;
              }
              case "faithfulness_flag": {
                const title = sectionList.find((x) => x.label === frame.section)?.title ?? frame.section;
                setFlags((f) => [...f, ...frame.flags.map((fl) => ({ section: title, claim: fl.claim }))]);
                break;
              }
              case "done": {
                if (kind === "generate") {
                  const generated =
                    frame.sections_generated?.length ?? sectionList.filter((s) => s.status === "done").length;
                  const failedLabels = frame.sections_failed ?? sectionList.filter((s) => s.status === "failed").map((s) => s.label);
                  const failed = failedLabels.map((l) => sectionList.find((s) => s.label === l)?.title ?? l);
                  setSummary({ generated, failed });
                }
                note("Finished");
                break;
              }
              case "error":
                note(frame.message);
                if (kind === "chat" || !currentSection || (frame.code && FATAL_CODES.has(frame.code))) {
                  setError(frame.message);
                }
                break;
            }
          },
          ac.signal,
        );
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          note("Stopped");
        } else {
          setError(errorText(e));
        }
      } finally {
        setStreaming(false);
        setRun((r) => (r ? { ...r, endedAt: Date.now(), stopped: ac.signal.aborted } : r));
        abortRef.current = null;
        const ref = draftUpdateRef.current;
        if (ref.timer) {
          clearTimeout(ref.timer);
          ref.timer = null;
        }
        if (ref.pendingVersion != null) {
          void onDraftUpdated?.(ref.pendingVersion);
          ref.pendingVersion = null;
        }
      }
    },
    [choice, draftId, onDraftUpdated, onThreadsChanged, persona, prompt],
  );

  useEffect(() => {
    if (!autoRun || !draftId || streaming) return;
    onAutoRunConsumed?.();
    void send(autoRun.preset, autoRun.prompt, autoRun.choice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, draftId]);

  function stop() {
    abortRef.current?.abort();
  }

  const running = sections.find((s) => s.status === "running");
  const runningIdx = running ? sections.indexOf(running) : -1;
  const doneCount = sections.filter((s) => s.status === "done").length;
  const elapsedTotal = run ? (run.endedAt ?? now) - run.startedAt : 0;

  let headline: string | null = null;
  if (run && streaming) {
    if (run.kind === "generate") {
      headline = running
        ? `${runningIdx + 1} of ${sections.length} · ${running.title} · ${fmtElapsed(now - (running.startedAt ?? now))}`
        : sections.length && doneCount === sections.length
          ? `Finishing up · ${fmtElapsed(elapsedTotal)}`
          : `Getting started · ${fmtElapsed(elapsedTotal)}`;
    } else {
      headline = `Working… · ${fmtElapsed(elapsedTotal)}`;
    }
  }

  let resultLine: { text: string; tone: "ok" | "warn" | "muted" } | null = null;
  if (run && !streaming) {
    if (run.stopped) {
      resultLine = { text: "Stopped. Anything already written stays in the document.", tone: "muted" };
    } else if (run.kind === "generate" && summary) {
      const total = summary.generated + summary.failed.length;
      if (summary.generated === 0) {
        resultLine = { text: "The draft couldn't be written. Please try again.", tone: "warn" };
      } else if (summary.failed.length === 0) {
        resultLine = {
          text: `Draft ready — ${summary.generated} section${summary.generated === 1 ? "" : "s"}`,
          tone: "ok",
        };
      } else {
        resultLine = { text: `Draft ready — ${summary.generated} of ${total} sections`, tone: "warn" };
      }
    } else if (run.kind === "chat" && !error) {
      resultLine = { text: "Done", tone: "ok" };
    }
  }

  return (
    <div className="space-y-3 text-[13px]">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">AI drafting assistant</h2>
        <span className="whitespace-nowrap rounded-full bg-agent/10 px-2 py-0.5 text-xs font-medium text-agent">
          {isReviewer ? "Suggestions only" : canRunAgent ? "Can edit" : "View only"}
        </span>
      </div>

      {!draftId && <p className="text-text-muted">Open a document to use the assistant.</p>}

      {draftId && (
        <>
          {run && (
            <div className="rounded-lg border border-border bg-surface-sunken p-3" aria-live="polite">
              {headline && (
                <div className="flex items-center gap-2 font-medium text-text">
                  <Spinner />
                  <span className="min-w-0 truncate">{headline}</span>
                </div>
              )}
              {resultLine && (
                <div
                  className={`font-medium ${
                    resultLine.tone === "ok"
                      ? "text-status-approved-text"
                      : resultLine.tone === "warn"
                        ? "text-status-changes-text"
                        : "text-text-muted"
                  }`}
                >
                  {resultLine.text}
                  {run.kind === "generate" && !run.stopped && summary && summary.generated > 0 && (
                    <span className="font-normal text-text-muted"> · {fmtElapsed(elapsedTotal)}</span>
                  )}
                </div>
              )}

              {sections.length > 0 && (
                <ol className="mt-2 space-y-1.5">
                  {sections.map((s) => (
                    <li key={s.label} className="flex items-start gap-2">
                      <span className="mt-0.5">
                        <SectionIcon status={s.status} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div
                          className={`flex items-baseline justify-between gap-2 ${
                            s.status === "pending" ? "text-text-muted" : "text-text"
                          }`}
                        >
                          <span className="min-w-0 truncate">{s.title}</span>
                          {s.status === "done" && s.startedAt && s.endedAt && (
                            <span className="shrink-0 text-xs text-text-muted">
                              {fmtElapsed(s.endedAt - s.startedAt)}
                            </span>
                          )}
                        </div>
                        {s.status === "failed" && s.error && (
                          <p className="mt-0.5 text-xs text-status-rejected-text">{s.error}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {flags.length > 0 && (
            <div className="rounded-lg border border-status-changes-border bg-status-changes-surface/50 p-3">
              <p className="font-medium text-status-changes-text">
                Please check {flags.length === 1 ? "this statement" : `these ${flags.length} statements`} against
                the sources
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {flags.map((f, i) => (
                  <li key={i} className="text-text">
                    &ldquo;{f.claim}&rdquo;
                    <span className="block text-xs text-text-muted">{f.section}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {reply && (
            <div className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-raised p-2.5 text-text">
              {reply}
            </div>
          )}

          {details.length > 0 && (
            <details
              className="text-xs text-text-muted"
              onToggle={(e) => setDetailsOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="cursor-pointer select-none hover:text-text">Details</summary>
              <ol ref={detailsRef} className="mt-1.5 max-h-40 space-y-0.5 overflow-auto pl-3">
                {details.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ol>
            </details>
          )}

          {error && (
            <p className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-2.5 text-status-rejected-text">
              {error}
            </p>
          )}

          <div className="space-y-2 border-t border-border pt-3">
            {!canRunAgent && !isReviewer && (
              <p className="text-text-muted">This document can&apos;t be edited at its current stage.</p>
            )}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              aria-label="What should the assistant do?"
              placeholder={
                isReviewer
                  ? "Describe what to check — the assistant will leave suggestions, not edits…"
                  : "Describe what to add or change…"
              }
              className="w-full rounded-lg border border-border-strong bg-surface-raised p-2 text-[13px] text-text outline-none focus:border-accent disabled:opacity-50"
            />
            <ModelPicker
              choice={choice}
              onChange={onChoiceChange}
              serverLlm={serverLlm}
              isAdmin={isAdmin}
              disabled={streaming}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void send()}
                className="rounded-lg bg-agent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-agent-hover disabled:opacity-50"
              >
                {streaming ? "Working…" : isReviewer ? "Suggest changes" : "Generate"}
              </button>
              {streaming && (
                <button
                  type="button"
                  onClick={stop}
                  className="ml-auto rounded-lg border border-border-strong px-3 py-1.5 text-[13px] text-text transition-colors hover:bg-surface-raised"
                >
                  Stop
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
