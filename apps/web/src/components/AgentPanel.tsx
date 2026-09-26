"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AgentFrame, type PersonaKey, streamAgentChat } from "@/lib/cfcApi";

type Provider = "mock" | "gemini" | "openai" | "anthropic";

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
  | { kind: "error"; text: string }
  | { kind: "done"; text: string };

// Remembers a BYOK key per provider, per browser — never sent anywhere but
// straight to /agent/chat (same as typing it in fresh). Deliberately client-
// side only: the project's BYOK design has no server-side key storage, so
// "remembering" a key has to live in the browser, not the account.
function apiKeyStorageKey(p: Provider): string {
  return `cfc.agentApiKey.${p}`;
}

function loadStoredApiKey(p: Provider): string {
  try {
    return window.localStorage.getItem(apiKeyStorageKey(p)) ?? "";
  } catch {
    return "";
  }
}

function storeApiKey(p: Provider, value: string): void {
  try {
    if (value) {
      window.localStorage.setItem(apiKeyStorageKey(p), value);
    } else {
      window.localStorage.removeItem(apiKeyStorageKey(p));
    }
  } catch {
    // Private browsing / blocked storage — key just won't persist.
  }
}

const PROVIDER_MODELS: Record<Provider, string> = {
  mock: "",
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o-mini",
  // Haiku, not Opus/Sonnet — this provider is meant for BYOK keys on a small
  // prepaid budget; see agent_llm.py's DEFAULT_MODELS for the same choice
  // server-side (this is only the placeholder shown before a key is typed).
  anthropic: "claude-haiku-4-5",
};

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
   * requiring the user to also type into this panel and click a button. */
  autoRun?: { preset: string; prompt: string } | null;
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

  // draft_intake state (2a) — a clarifying Q&A round that precedes
  // draft_generator; see agent_presets.draft_intake_system for why the
  // agent's first action must be a corpus search, not a generic question.
  const [phase, setPhase] = useState<Phase>("idle");
  const [intakeBrief, setIntakeBrief] = useState("");
  const [intakeTranscript, setIntakeTranscript] = useState<IntakeTurn[]>([]);
  const [intakeTurn, setIntakeTurn] = useState(1);

  const effectiveModel = useMemo(() => model.trim() || PROVIDER_MODELS[provider] || "", [model, provider]);
  const needsKey = provider !== "mock";
  const canSend = !!draftId && !!prompt.trim() && !streaming && (!needsKey || !!apiKey.trim());

  const send = useCallback(
    async (
      preset?: string,
      promptOverride?: string,
      presetArgs?: Record<string, unknown>,
    ): Promise<SendResult | null> => {
      if (!draftId) return null;
      const effectivePrompt = (promptOverride ?? prompt).trim();
      if (!effectivePrompt) return null;
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
            provider,
            api_key: needsKey ? apiKey.trim() : undefined,
            model: effectiveModel || undefined,
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
              case "draft_updated":
                setLog((L) => [
                  ...L,
                  { kind: "draft_updated", version: frame.version, tracked: frame.tracked },
                ]);
                onDraftUpdated?.(frame.version);
                break;
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
      }
      return { questionText, ready };
    },
    [apiKey, draftId, effectiveModel, needsKey, onDraftUpdated, persona, prompt, provider],
  );

  // Runs one draft_intake turn: `replyText` is the user's answer to the
  // previous question (undefined only for the very first call, which has
  // nothing to reply to yet — just the original brief). `briefOverride` is
  // needed for that same first call, since setIntakeBrief()'s update isn't
  // visible in this closure until the next render.
  const runIntakeTurn = useCallback(
    async (replyText?: string, briefOverride?: string) => {
      const brief = briefOverride ?? intakeBrief;
      const newTranscript = replyText
        ? [...intakeTranscript, { role: "user" as const, text: replyText }]
        : intakeTranscript;
      setIntakeTranscript(newTranscript);
      setPrompt("");
      const result = await send("draft_intake", brief, {
        brief,
        transcript: newTranscript,
        turn_count: intakeTurn,
      });
      if (!result) return;
      if (result.ready) {
        setPhase("generating");
        setIntakeTranscript([]);
        await send("draft_generator", result.ready.enrichedBrief || brief);
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
    if (autoRun.preset === "draft_intake" || autoRun.preset === "draft-intake") {
      setPhase("intake");
      setIntakeBrief(autoRun.prompt);
      setIntakeTranscript([]);
      setIntakeTurn(1);
      void runIntakeTurn(undefined, autoRun.prompt);
      return;
    }
    setPrompt(autoRun.prompt);
    void send(autoRun.preset, autoRun.prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, draftId]);

  function cancel() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60 p-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-zinc-500">
          {isReviewer ? "Review" : "Ask the agent"}
        </div>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">
          {isReviewer ? "suggest only" : "Sprint 4"}
        </span>
      </div>

      {!draftId && (
        <p className="text-[11px] text-zinc-500">Open a draft to run the agent.</p>
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
                className={`rounded px-1 py-1 uppercase tracking-wide ${
                  provider === p ? "bg-zinc-700 text-zinc-100" : "bg-zinc-950 text-zinc-500 hover:text-zinc-300"
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
              className="mt-1.5 w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 font-mono text-[10px] text-zinc-100"
            />
          )}
          {needsKey && (
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={`model (default: ${PROVIDER_MODELS[provider]})`}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[10px] text-zinc-100"
            />
          )}

          {phase === "intake" && intakeTranscript.length > 0 && (
            <p className="mt-1.5 text-[11px] text-amber-300">
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
            className="mt-1.5 w-full rounded border border-zinc-700 bg-zinc-950 p-1.5 text-[11px] text-zinc-100 focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />

          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {phase === "intake" ? (
              <>
                <button
                  type="button"
                  disabled={!draftId || !prompt.trim() || streaming}
                  onClick={() => void runIntakeTurn(prompt.trim())}
                  className="rounded bg-indigo-600 px-2 py-1 text-[11px] font-medium hover:bg-indigo-500 disabled:opacity-50"
                >
                  {streaming ? "…" : "Send reply"}
                </button>
                <button
                  type="button"
                  disabled={streaming}
                  onClick={() => void skipIntake()}
                  className="rounded border border-zinc-600 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
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
                className="rounded bg-indigo-600 px-2 py-1 text-[11px] font-medium hover:bg-indigo-500 disabled:opacity-50"
              >
                {streaming ? "…" : isReviewer ? "Post review" : "Run agent"}
              </button>
            )}
            {streaming && (
              <button
                type="button"
                onClick={cancel}
                className="ml-auto rounded border border-zinc-600 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
            )}
          </div>

          {output && (
            <div className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-950 p-1.5 text-[11px] text-zinc-200">
              {output}
            </div>
          )}

          {log.length > 0 && (
            <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-[10px]">
              {log.map((entry, i) => (
                <li key={i} className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1">
                  {entry.kind === "start" && (
                    <span className="text-zinc-400">
                      <span className="mr-1 text-[9px] uppercase text-zinc-500">start</span>
                      {entry.text}
                    </span>
                  )}
                  {entry.kind === "preset" && (
                    <span className="text-indigo-300">
                      <span className="mr-1 text-[9px] uppercase text-zinc-500">preset</span>
                      {entry.text}
                    </span>
                  )}
                  {entry.kind === "tool_call" && (
                    <div>
                      <span className="mr-1 text-[9px] uppercase text-cyan-400">call</span>
                      <span className="font-mono text-cyan-200">{entry.tool}</span>
                      <span className="ml-1 text-zinc-500">{entry.args}</span>
                    </div>
                  )}
                  {entry.kind === "tool_result" && (
                    <div>
                      <span
                        className={`mr-1 text-[9px] uppercase ${entry.ok ? "text-emerald-400" : "text-red-400"}`}
                      >
                        {entry.ok ? "result" : "err"}
                      </span>
                      <span className="font-mono text-zinc-300">{entry.tool}</span>
                      <span className="ml-1 text-zinc-500">{entry.snippet}</span>
                    </div>
                  )}
                  {entry.kind === "draft_updated" && (
                    <div className="text-emerald-300">
                      <span className="mr-1 text-[9px] uppercase text-emerald-500">draft</span>
                      v{entry.version} written{entry.tracked ? " (tracked)" : ""}
                    </div>
                  )}
                  {entry.kind === "section" && (
                    <div className={entry.ok === false ? "text-red-400" : "text-amber-300"}>
                      <span className="mr-1 text-[9px] uppercase text-amber-500">section</span>
                      {entry.text}
                    </div>
                  )}
                  {entry.kind === "done" && (
                    <span className="text-zinc-500">
                      <span className="mr-1 text-[9px] uppercase">done</span>
                      {entry.text}
                    </span>
                  )}
                  {entry.kind === "error" && (
                    <span className="text-red-400">
                      <span className="mr-1 text-[9px] uppercase">error</span>
                      {entry.text}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {error && (
            <p className="mt-1 text-[10px] text-red-400">{error}</p>
          )}
        </>
      )}
    </div>
  );
}
