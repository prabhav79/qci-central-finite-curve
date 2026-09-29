"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentFrame,
  type PersonaKey,
  type Provider,
  PROVIDER_MODELS,
  loadStoredApiKey,
  storeApiKey,
  streamAgentChat,
} from "@/lib/cfcApi";

type SendResult = {
  questionText: string;
  ready: { enrichedBrief: string; keyDocCount: number } | null;
};

type LogEntry =
  | { kind: "start"; text: string }
  | { kind: "preset"; text: string }
  | { kind: "tool_call"; tool: string; args: string; id: string }
  | { kind: "tool_result"; tool: string; ok: boolean; snippet: string; id: string }
  | { kind: "draft_updated"; version: number; tracked: boolean }
  | { kind: "section"; text: string; ok?: boolean }
  | { kind: "faithfulness"; section: string; flags: { claim: string; score: number }[] }
  | { kind: "error"; text: string }
  | { kind: "done"; text: string };

type ProviderOverride = { provider: Provider; apiKey: string; model: string };

type Phase = "idle" | "intake" | "generating";
type IntakeTurn = { role: "user" | "assistant"; text: string };

export function AgentPanel({
  draftId,
  persona,
  superdocRole,
  canRunAgent,
  onDraftUpdated,
  onThreadsChanged,
  autoRun,
  onAutoRunConsumed,
}: {
  draftId: string | undefined;
  persona: PersonaKey;
  /** Drives the two-entry-point split (see 2c): "suggester" sessions are
   * always routed server-side into the tool-restricted redline path
   * regardless of what's sent here — this prop only changes labeling, the
   * server enforces the actual restriction. */
  superdocRole?: string;
  canRunAgent: boolean;
  onDraftUpdated?: (version: number) => void;
  onThreadsChanged?: () => void;
  /** Fire a preset immediately once this draft is ready — used to kick off
   * generation right after "Create & generate" in NewDraftModal, without
   * requiring the user to also type into this panel and click a button.
   * provider/apiKey/model carry the choice made in that modal — passed as
   * plain values (not through this panel's own provider state) because the
   * very first send() of the run fires from this same effect tick, before
   * a setProvider() call could take effect via React's async state update. */
  autoRun?: { preset: string; prompt: string; provider?: Provider; apiKey?: string; model?: string } | null;
  onAutoRunConsumed?: () => void;
}) {
  const isReviewer = superdocRole === "suggester";
  const [provider, setProvider] = useState<Provider>("mock");
  const [apiKey, setApiKey] = useState("");

  function updateApiKey(value: string) {
    setApiKey(value);
    storeApiKey(provider, value);
  }
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [output, setOutput] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Throttles onDraftUpdated during a run: draft_generator emits one
  // draft_updated frame per section (up to 7 per run), and each one was
  // triggering a full editor reload (loadDraft: refetch + SuperDoc reinit)
  // back to back — visible as rapid flicker. Collapse same-run updates to
  // at most one reload per window, always flushing the final version once
  // the stream ends so the editor never ends up stale.
  const draftUpdateRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; pendingVersion: number | null }>({
    timer: null,
    pendingVersion: null,
  });

  // draft_intake state (2a) — a clarifying Q&A round that precedes
  // draft_generator; see agent_presets.draft_intake_system for why the
  // agent's first action must be a corpus search, not a generic question.
  const [phase, setPhase] = useState<Phase>("idle");
  const [intakeBrief, setIntakeBrief] = useState("");
  const [intakeTranscript, setIntakeTranscript] = useState<IntakeTurn[]>([]);
  const [intakeTurn, setIntakeTurn] = useState(1);

  const needsKey = provider !== "mock";
  const canSend = !!draftId && !!prompt.trim() && !streaming && (!needsKey || !!apiKey.trim());

  const send = useCallback(
    async (
      preset?: string,
      promptOverride?: string,
      presetArgs?: Record<string, unknown>,
      providerOverride?: ProviderOverride,
    ): Promise<SendResult | null> => {
      if (!draftId) return null;
      const effectivePrompt = (promptOverride ?? prompt).trim();
      if (!effectivePrompt) return null;
      const effectiveProvider = providerOverride?.provider ?? provider;
      const effectiveApiKey = providerOverride?.apiKey ?? apiKey;
      const effectiveProviderModel =
        (providerOverride?.model ?? model).trim() || PROVIDER_MODELS[effectiveProvider] || "";
      setStreaming(true);
      setOutput("");
      setLog([]);
      setError(null);
      const ac = new AbortController();
      abortRef.current = ac;
      let questionText = "";
      let ready: SendResult["ready"] = null;
      try {
        await streamAgentChat(
          draftId,
          persona,
          {
            prompt: effectivePrompt,
            provider: effectiveProvider,
            api_key: effectiveProvider !== "mock" ? effectiveApiKey.trim() : undefined,
            model: effectiveProviderModel || undefined,
            preset,
            preset_args: presetArgs,
          },
          (frame: AgentFrame) => {
            switch (frame.type) {
              case "start":
                setLog((L) => [
                  ...L,
                  {
                    kind: "start",
                    text: `${frame.providers.join(" → ")} · v${frame.version}${frame.tracked ? " · tracked" : ""}${
                      frame.can_run_agent_mutate ? "" : " · read-only"
                    }`,
                  },
                ]);
                break;
              case "preset":
                setLog((L) => [...L, { kind: "preset", text: frame.name }]);
                break;
              case "token":
                setOutput((s) => s + frame.text);
                questionText += frame.text;
                break;
              case "tool_call":
                setLog((L) => [
                  ...L,
                  {
                    kind: "tool_call",
                    id: frame.id,
                    tool: frame.name,
                    args: JSON.stringify(frame.args).slice(0, 200),
                  },
                ]);
                break;
              case "tool_result": {
                const errMsg = (frame.result as { error?: string }).error;
                setLog((L) => [
                  ...L,
                  {
                    kind: "tool_result",
                    id: frame.id,
                    tool: frame.name,
                    ok: !errMsg,
                    snippet: errMsg
                      ? errMsg.slice(0, 220)
                      : JSON.stringify(frame.result).slice(0, 220),
                  },
                ]);
                if (frame.name === "cfc_propose_redline" && !errMsg) {
                  onThreadsChanged?.();
                }
                break;
              }
              case "draft_updated": {
                setLog((L) => [
                  ...L,
                  { kind: "draft_updated", version: frame.version, tracked: frame.tracked },
                ]);
                const ref = draftUpdateRef.current;
                if (!ref.timer) {
                  onDraftUpdated?.(frame.version);
                  ref.pendingVersion = null;
                  ref.timer = setTimeout(() => {
                    ref.timer = null;
                  }, 1500);
                } else {
                  // Throttled — a later section will supersede this one, so
                  // just remember its version for the end-of-run flush.
                  ref.pendingVersion = frame.version;
                }
                break;
              }
              case "section_start":
                setLog((L) => [...L, { kind: "section", text: `Drafting ${frame.title}…` }]);
                break;
              case "section_result":
                setLog((L) => [
                  ...L,
                  {
                    kind: "section",
                    text: frame.ok ? `${frame.section} done` : `${frame.section} failed: ${frame.error ?? "unknown error"}`,
                    ok: frame.ok,
                  },
                ]);
                break;
              case "faithfulness_flag":
                // Soft QA signal only — never blocks or edits anything, just
                // surfaces claims the section made that didn't turn up in
                // what was actually retrieved for it, for the human to check.
                setLog((L) => [...L, { kind: "faithfulness", section: frame.section, flags: frame.flags }]);
                break;
              case "ready_to_generate": {
                const count = frame.key_docs?.length ?? 0;
                ready = { enrichedBrief: frame.enriched_brief ?? "", keyDocCount: count };
                setLog((L) => [
                  ...L,
                  { kind: "section", text: `Ready to draft — grounded in ${count} reference document${count === 1 ? "" : "s"}.` },
                ]);
                break;
              }
              case "done": {
                const gen = frame.sections_generated;
                const failed = frame.sections_failed;
                const summary =
                  gen || failed
                    ? `${frame.reason} · ${gen?.length ?? 0} generated${failed?.length ? `, ${failed.length} failed` : ""}`
                    : frame.reason;
                setLog((L) => [...L, { kind: "done", text: summary }]);
                break;
              }
              case "error":
                setError(frame.message);
                setLog((L) => [...L, { kind: "error", text: frame.message }]);
                break;
            }
          },
          ac.signal,
        );
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
        const ref = draftUpdateRef.current;
        if (ref.timer) {
          clearTimeout(ref.timer);
          ref.timer = null;
        }
        if (ref.pendingVersion != null) {
          onDraftUpdated?.(ref.pendingVersion);
          ref.pendingVersion = null;
        }
      }
      return { questionText, ready };
    },
    [apiKey, draftId, model, onDraftUpdated, persona, prompt, provider],
  );

  // Runs one draft_intake turn: `replyText` is the user's answer to the
  // previous question (undefined only for the very first call, which has
  // nothing to reply to yet — just the original brief). `briefOverride` is
  // needed for that same first call, since setIntakeBrief()'s update isn't
  // visible in this closure until the next render.
  const runIntakeTurn = useCallback(
    async (replyText?: string, briefOverride?: string, providerOverride?: ProviderOverride) => {
      const brief = briefOverride ?? intakeBrief;
      const newTranscript = replyText
        ? [...intakeTranscript, { role: "user" as const, text: replyText }]
        : intakeTranscript;
      setIntakeTranscript(newTranscript);
      setPrompt("");
      const result = await send(
        "draft_intake",
        brief,
        { brief, transcript: newTranscript, turn_count: intakeTurn },
        providerOverride,
      );
      if (!result) return;
      if (result.ready) {
        setPhase("generating");
        setIntakeTranscript([]);
        await send("draft_generator", result.ready.enrichedBrief || brief, undefined, providerOverride);
        setPhase("idle");
      } else {
        setIntakeTranscript([...newTranscript, { role: "assistant", text: result.questionText }]);
        setIntakeTurn((t) => t + 1);
      }
    },
    [intakeBrief, intakeTranscript, intakeTurn, send],
  );

  async function skipIntake() {
    const brief = intakeBrief || prompt.trim();
    setPhase("generating");
    setIntakeTranscript([]);
    setPrompt("");
    await send("draft_generator", brief);
    setPhase("idle");
  }

  useEffect(() => {
    if (!autoRun || !draftId || streaming) return;
    onAutoRunConsumed?.();
    // The chosen provider/key travel as plain values (providerOverride) for
    // this very first send() — setProvider() below won't be visible inside
    // this same effect's closures until next render — but state is still
    // updated too, so the UI reflects the choice and any later turn (e.g.
    // answering a follow-up clarifying question) picks it up normally.
    let providerOverride: ProviderOverride | undefined;
    if (autoRun.provider) {
      const resolvedApiKey = autoRun.apiKey ?? (autoRun.provider === "mock" ? "" : loadStoredApiKey(autoRun.provider));
      const resolvedModel = autoRun.model ?? "";
      setProvider(autoRun.provider);
      setApiKey(resolvedApiKey);
      setModel(resolvedModel);
      providerOverride = { provider: autoRun.provider, apiKey: resolvedApiKey, model: resolvedModel };
    }
    if (autoRun.preset === "draft_intake" || autoRun.preset === "draft-intake") {
      setPhase("intake");
      setIntakeBrief(autoRun.prompt);
      setIntakeTranscript([]);
      setIntakeTurn(1);
      void runIntakeTurn(undefined, autoRun.prompt, providerOverride);
      return;
    }
    setPrompt(autoRun.prompt);
    void send(autoRun.preset, autoRun.prompt, undefined, providerOverride);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, draftId]);

  function cancel() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          {isReviewer ? "Review" : "Ask the agent"}
        </div>
        <span className="rounded-full bg-agent/10 px-1.5 py-0.5 text-[9px] font-medium text-agent">
          {isReviewer ? "suggest only" : canRunAgent ? "insert & edit" : "read-only"}
        </span>
      </div>

      {!draftId && (
        <p className="text-[11px] text-text-muted">Open a draft to run the agent.</p>
      )}

      {draftId && (
        <>
          <div className="grid grid-cols-4 gap-1 text-[10px]">
            {(["mock", "gemini", "openai", "anthropic"] as Provider[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setProvider(p);
                  setModel("");
                  setApiKey(loadStoredApiKey(p));
                }}
                className={`rounded-md px-1 py-1 uppercase tracking-wide transition-colors ${
                  provider === p ? "bg-agent text-white" : "bg-surface-raised text-text-muted hover:text-text"
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {needsKey && (
            <input
              type="password"
              value={apiKey}
              onChange={(e) => updateApiKey(e.target.value)}
              placeholder={`${provider} API key (BYOK — remembered in this browser only)`}
              className="mt-1.5 w-full rounded-lg border border-border-strong bg-surface-raised px-1.5 py-1 font-mono text-[10px] text-text outline-none focus:border-accent"
            />
          )}
          {needsKey && (
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={`model (default: ${PROVIDER_MODELS[provider]})`}
              className="mt-1 w-full rounded-lg border border-border-strong bg-surface-raised px-1.5 py-1 text-[10px] text-text outline-none focus:border-accent"
            />
          )}

          {phase === "intake" && intakeTranscript.length > 0 && (
            <p className="mt-1.5 rounded-lg border border-agent/30 bg-agent/10 p-2 text-[11px] text-text">
              {intakeTranscript[intakeTranscript.length - 1].text}
            </p>
          )}

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            disabled={phase === "generating"}
            placeholder={
              phase === "intake"
                ? "Answer the question above, then press Send reply."
                : isReviewer
                  ? "Ask the agent to review this draft against precedent and leave suggestions — it never edits the document directly."
                  : canRunAgent
                    ? "Ask the agent to insert / modify sections using precedent, or describe a new document to generate."
                    : "Read-only for this persona/status — the agent can search but not mutate."
            }
            className="mt-1.5 w-full rounded-lg border border-border-strong bg-surface-raised p-1.5 text-[11px] text-text outline-none focus:border-accent disabled:opacity-50"
          />

          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {phase === "intake" ? (
              <>
                <button
                  type="button"
                  disabled={!draftId || !prompt.trim() || streaming}
                  onClick={() => void runIntakeTurn(prompt.trim())}
                  className="rounded-lg bg-agent px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-agent-hover disabled:opacity-50"
                >
                  {streaming ? "…" : "Send reply"}
                </button>
                <button
                  type="button"
                  disabled={streaming}
                  onClick={() => void skipIntake()}
                  className="rounded-lg border border-border-strong px-2 py-1 text-[10px] text-text transition-colors hover:bg-surface-raised disabled:opacity-50"
                  title="Generate now from the original brief, without answering more questions"
                >
                  Skip questions, generate now
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={!canSend || phase === "generating"}
                onClick={() => void send()}
                className="rounded-lg bg-agent px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-agent-hover disabled:opacity-50"
              >
                {streaming ? "…" : isReviewer ? "Post review" : "Run agent"}
              </button>
            )}
            {streaming && (
              <button
                type="button"
                onClick={cancel}
                className="ml-auto rounded-lg border border-border-strong px-2 py-1 text-[10px] text-text transition-colors hover:bg-surface-raised"
              >
                Cancel
              </button>
            )}
          </div>

          {output && (
            <div className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-raised p-1.5 text-[11px] text-text">
              {output}
            </div>
          )}

          {log.length > 0 && (
            <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-[10px]">
              {log.map((entry, i) => (
                <li key={i} className="rounded-lg border border-border bg-surface-raised px-1.5 py-1">
                  {entry.kind === "start" && (
                    <span className="text-text-muted">
                      <span className="mr-1 text-[9px] uppercase text-text-muted">start</span>
                      {entry.text}
                    </span>
                  )}
                  {entry.kind === "preset" && (
                    <span className="text-agent">
                      <span className="mr-1 text-[9px] uppercase text-text-muted">preset</span>
                      {entry.text}
                    </span>
                  )}
                  {entry.kind === "tool_call" && (
                    <div>
                      <span className="mr-1 text-[9px] uppercase text-accent">call</span>
                      <span className="font-mono text-accent">{entry.tool}</span>
                      <span className="ml-1 text-text-muted">{entry.args}</span>
                    </div>
                  )}
                  {entry.kind === "tool_result" && (
                    <div>
                      <span
                        className={`mr-1 text-[9px] uppercase ${entry.ok ? "text-status-approved-text" : "text-status-rejected-text"}`}
                      >
                        {entry.ok ? "result" : "err"}
                      </span>
                      <span className="font-mono text-text">{entry.tool}</span>
                      <span className="ml-1 text-text-muted">{entry.snippet}</span>
                    </div>
                  )}
                  {entry.kind === "draft_updated" && (
                    <div className="text-status-approved-text">
                      <span className="mr-1 text-[9px] uppercase">draft</span>
                      v{entry.version} written{entry.tracked ? " (tracked)" : ""}
                    </div>
                  )}
                  {entry.kind === "section" && (
                    <div className={entry.ok === false ? "text-status-rejected-text" : "text-agent"}>
                      <span className="mr-1 text-[9px] uppercase">section</span>
                      {entry.text}
                    </div>
                  )}
                  {entry.kind === "faithfulness" && (
                    <div className="rounded border border-status-changes-border bg-status-changes-surface/40 p-1">
                      <div className="text-[9px] uppercase text-status-changes-text">
                        possibly unsupported — {entry.section}
                      </div>
                      <ul className="mt-0.5 space-y-0.5">
                        {entry.flags.map((f, fi) => (
                          <li key={fi} className="text-text-muted">
                            <span className="text-status-changes-text">[{f.score}]</span> &ldquo;{f.claim}&rdquo;
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {entry.kind === "done" && (
                    <span className="text-text-muted">
                      <span className="mr-1 text-[9px] uppercase">done</span>
                      {entry.text}
                    </span>
                  )}
                  {entry.kind === "error" && (
                    <span className="text-status-rejected-text">
                      <span className="mr-1 text-[9px] uppercase">error</span>
                      {entry.text}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {error && (
            <p className="mt-1 text-[10px] text-status-rejected-text">{error}</p>
          )}
        </>
      )}
    </div>
  );
}
