"use client";

import { useEffect, useRef, useState } from "react";
import { type AgentFrame, type PersonaKey, streamAgentChat } from "@/lib/cfcApi";
import type { GenerationProviderChoice } from "@/components/NewDraftModal";
import { Modal } from "@/components/Modal";
import { renderInlineEmphasis } from "@/lib/inlineMarkdown";

type QaPair = { question: string; answer: string };
type TrailItem = { label: string };

const FALLBACK_MAX_TURNS = 6;

function toolTrailLabel(name: string, args: Record<string, unknown>): string | null {
  if (name === "cfc_search_corpus") {
    const query = String(args.query ?? "").slice(0, 70);
    return `Searching QCI's corpus for "${query}"…`;
  }
  if (name === "cfc_get_document") {
    return `Reading document ${String(args.doc_id ?? "")}…`;
  }
  if (name === "cfc_ready_to_generate") {
    return null; // the dedicated ready_to_generate frame handles this transition
  }
  return `Running ${name}…`;
}

/**
 * Centered Q&A overlay that runs the draft_intake preset turn by turn,
 * replacing the old inline-in-AgentPanel version. Deliberately forks its own
 * streamAgentChat loop rather than sharing AgentPanel's send() — intake's
 * tool surface is a fixed, narrow subset (INTAKE_TOOL_SCHEMAS: search/get-
 * document/ready-to-generate only), so a purpose-built reducer here is the
 * correctly-sized consumer, not a risky duplication of general-purpose logic.
 */
export function DraftIntakeOverlay({
  open,
  draftId,
  title,
  brief,
  providerChoice,
  persona,
  onComplete,
  onAbandon,
}: {
  open: boolean;
  draftId: string;
  title: string;
  brief: string;
  providerChoice: GenerationProviderChoice;
  persona: PersonaKey;
  onComplete: (enrichedBrief: string) => void;
  onAbandon: () => void;
}) {
  const [history, setHistory] = useState<QaPair[]>([]);
  const [turnCount, setTurnCount] = useState(1);
  const [maxTurns, setMaxTurns] = useState<number | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [trail, setTrail] = useState<TrailItem[]>([]);
  const [thinkingLabel, setThinkingLabel] = useState("Getting started…");
  const [reply, setReply] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [readyMessage, setReadyMessage] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Deliberately NOT guarded by a "has this fired" ref on top of the abort
  // below: React 18 StrictMode's dev-only mount→cleanup→mount dance would
  // otherwise fire this effect, let the fetch start, then the *second*
  // mount's guard would block the real retry — leaving the only request
  // that ever ran as the one StrictMode immediately aborted. Letting the
  // effect re-fire naturally after its own cleanup aborts the stale
  // in-flight request is the correct fix: StrictMode's cleanup cancels call
  // A before call B starts, so exactly one request ever completes, in both
  // dev (two sequential calls, first harmlessly aborted) and prod (effects
  // run once, so just the one call).
  useEffect(() => {
    if (!open) return;
    void runTurn(undefined);
    return () => {
      abortRef.current?.abort();
      // Synchronous, unlike the eventual AbortError rejection this triggers
      // (fetch rejects on its own microtask timing) — resetting this here
      // rather than only in runTurn's catch block is what lets the very
      // next effect invocation's runTurn() call actually start instead of
      // bouncing off a flag the aborted call hasn't gotten around to
      // clearing yet.
      inFlightRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function runTurn(replyText: string | undefined) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStreaming(true);
    setErrorMsg(null);
    // Captured BEFORE anything resets — this is the question `replyText` is
    // actually answering. Reading the `currentQuestion` *state* later (after
    // the stream below has already overwritten it with the NEXT question)
    // would silently pair the wrong question with this answer.
    const answeredQuestion = currentQuestion;
    setCurrentQuestion("");
    setTrail([]);
    setThinkingLabel("Getting started…");

    const pastTurns = history.flatMap((h) => [
      { role: "assistant", text: h.question },
      { role: "user", text: h.answer },
    ]);
    const sentTranscript = replyText
      ? [...pastTurns, { role: "assistant", text: answeredQuestion }, { role: "user", text: replyText }]
      : pastTurns;

    const ac = new AbortController();
    abortRef.current = ac;
    let liveText = "";
    const readyRef: { current: { enrichedBrief: string; keyDocCount: number } | null } = { current: null };
    let frameError: string | null = null;

    try {
      await streamAgentChat(
        draftId,
        persona,
        {
          prompt: brief,
          provider: providerChoice.provider,
          api_key: providerChoice.provider !== "mock" ? providerChoice.apiKey.trim() : undefined,
          model: providerChoice.model.trim() || undefined,
          preset: "draft_intake",
          preset_args: { brief, title, transcript: sentTranscript, turn_count: turnCount },
        },
        (frame: AgentFrame) => {
          switch (frame.type) {
            case "preset":
              if (frame.max_turns) setMaxTurns(frame.max_turns);
              break;
            case "tool_call": {
              // A new tool call means any text streamed before it was
              // pre-tool-call narration, not the final question — discard it
              // rather than let it leak into the display (the root cause of
              // the old "I'll search... Good, I can see..." clutter).
              liveText = "";
              setCurrentQuestion("");
              const label = toolTrailLabel(frame.name, frame.args);
              if (label) {
                setThinkingLabel(label);
                setTrail((t) => [...t, { label }]);
              }
              break;
            }
            case "token":
              liveText += frame.text;
              setCurrentQuestion(liveText);
              break;
            case "ready_to_generate": {
              const count = frame.key_docs?.length ?? 0;
              readyRef.current = { enrichedBrief: frame.enriched_brief || brief, keyDocCount: count };
              break;
            }
            case "error":
              frameError = frame.message;
              break;
          }
        },
        ac.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        frameError = e instanceof Error ? e.message : String(e);
      } else {
        // A newer call may already be active by the time this rejection
        // arrives (the effect cleanup that triggered this abort already
        // reset inFlightRef synchronously) — don't touch streaming/inFlight
        // here, that would risk clobbering the newer call's own state.
        return;
      }
    }

    inFlightRef.current = false;
    setStreaming(false);

    if (frameError) {
      // Deliberately do NOT touch history/turnCount here — a failed turn
      // must be retryable with the same reply text, not silently recorded
      // as an empty answer that advances the conversation.
      setErrorMsg(frameError);
      return;
    }

    const ready = readyRef.current;
    if (ready) {
      if (replyText) {
        setHistory((h) => [...h, { question: answeredQuestion, answer: replyText }]);
      }
      setReadyMessage(
        `Grounded in ${ready.keyDocCount} reference document${ready.keyDocCount === 1 ? "" : "s"} — starting generation…`,
      );
      const enrichedBrief = ready.enrichedBrief;
      setTimeout(() => onComplete(enrichedBrief), 700);
      return;
    }

    // Defense in depth: the server is told to force cfc_ready_to_generate on
    // the final turn (agent_presets.draft_intake_system's force_final), but
    // if it somehow still just asks another question past the limit, don't
    // let the user get stuck — generate from the brief as-is.
    if (turnCount >= (maxTurns ?? FALLBACK_MAX_TURNS)) {
      onComplete(brief);
      return;
    }

    if (replyText) {
      setHistory((h) => [...h, { question: answeredQuestion, answer: replyText }]);
    }
    setTurnCount((t) => t + 1);
    setReply("");
  }

  function submitReply() {
    const trimmed = reply.trim();
    if (!trimmed || streaming) return;
    void runTurn(trimmed);
  }

  function skip() {
    abortRef.current?.abort();
    onComplete(brief);
  }

  const isThinking = streaming && !currentQuestion;

  return (
    <Modal open={open} onClose={onAbandon} maxWidth="max-w-xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">A few quick questions</h2>
        <button
          type="button"
          onClick={onAbandon}
          aria-label="Close"
          className="rounded-md px-1.5 py-0.5 text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
        >
          ×
        </button>
      </div>

      {history.length > 0 && (
        <ul className="mb-3 max-h-40 space-y-2 overflow-auto">
          {history.map((h, i) => (
            <li key={i} className="rounded-lg border border-border bg-surface-sunken p-2 text-xs">
              <div className="flex gap-1.5 text-text-muted">
                <span className="shrink-0 font-medium text-accent">Q{i + 1}</span>
                <span>{renderInlineEmphasis(h.question)}</span>
              </div>
              <div className="mt-1 flex gap-1.5 text-text">
                <span className="shrink-0 text-text-muted">↳</span>
                <span>{h.answer}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {readyMessage ? (
        <div className="animate-rise-in rounded-lg border border-status-approved-border bg-status-approved-surface p-4 text-center text-sm text-status-approved-text">
          {readyMessage}
        </div>
      ) : isThinking ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken p-4 text-sm text-text-muted">
          <span className="h-2 w-2 animate-pulse rounded-full bg-agent" aria-hidden />
          {thinkingLabel}
        </div>
      ) : (
        <div key={turnCount} className="animate-rise-in rounded-lg border border-agent/30 bg-agent/10 p-3">
          <span className="text-[10px] font-medium uppercase tracking-wide text-agent">
            Question {turnCount}
            {maxTurns ? ` of up to ${maxTurns}` : ""}
          </span>
          <p className="mt-1 text-sm text-text">{renderInlineEmphasis(currentQuestion)}</p>
        </div>
      )}

      {trail.length > 1 && (
        <details className="mt-2 text-[10px] text-text-muted">
          <summary className="cursor-pointer select-none hover:text-text">
            {trail.length} research step{trail.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {trail.map((t, i) => (
              <li key={i}>{t.label}</li>
            ))}
          </ul>
        </details>
      )}

      {errorMsg && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-status-rejected-border bg-status-rejected-surface p-2 text-xs text-status-rejected-text">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => void runTurn(reply.trim() || undefined)}
            className="shrink-0 rounded-md border border-status-rejected-border px-2 py-0.5 font-medium transition-colors hover:bg-status-rejected-surface/60"
          >
            Retry
          </button>
        </div>
      )}

      {!readyMessage && (
        <>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitReply();
              }
            }}
            disabled={streaming}
            rows={2}
            placeholder={isThinking ? "Searching for context…" : "Type your answer…"}
            className="mt-3 w-full rounded-lg border border-border-strong bg-surface-sunken p-2 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
          />

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={submitReply}
              disabled={streaming || !reply.trim()}
              className="rounded-lg bg-agent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-agent-hover disabled:opacity-50"
            >
              {streaming ? "…" : "Next"}
            </button>
            <button
              type="button"
              onClick={skip}
              className="rounded-lg border border-border-strong px-3 py-1.5 text-xs text-text transition-colors hover:bg-surface-sunken"
            >
              Skip remaining questions, generate now
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
