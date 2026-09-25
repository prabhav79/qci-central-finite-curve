"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AgentFrame, type PersonaKey, streamAgentChat } from "@/lib/cfcApi";

type Provider = "mock" | "gemini" | "openai";

type LogEntry =
  | { kind: "start"; text: string }
  | { kind: "preset"; text: string }
  | { kind: "tool_call"; tool: string; args: string; id: string }
  | { kind: "tool_result"; tool: string; ok: boolean; snippet: string; id: string }
  | { kind: "draft_updated"; version: number; tracked: boolean }
  | { kind: "section"; text: string; ok?: boolean }
  | { kind: "error"; text: string }
  | { kind: "done"; text: string };

const PROVIDER_MODELS: Record<Provider, string> = {
  mock: "",
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o-mini",
};

export function AgentPanel({
  draftId,
  persona,
  canRunAgent,
  onDraftUpdated,
  onThreadsChanged,
  autoRun,
  onAutoRunConsumed,
}: {
  draftId: string | undefined;
  persona: PersonaKey;
  canRunAgent: boolean;
  onDraftUpdated?: (version: number) => void;
  onThreadsChanged?: () => void;
  /** Fire a preset immediately once this draft is ready — used to kick off
   * generation right after "Create & generate" in NewDraftModal, without
   * requiring the user to also type into this panel and click a button. */
  autoRun?: { preset: string; prompt: string } | null;
  onAutoRunConsumed?: () => void;
}) {
  const [provider, setProvider] = useState<Provider>("mock");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [output, setOutput] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const effectiveModel = useMemo(() => model.trim() || PROVIDER_MODELS[provider] || "", [model, provider]);
  const needsKey = provider !== "mock";
  const canSend = !!draftId && !!prompt.trim() && !streaming && (!needsKey || !!apiKey.trim());

  const send = useCallback(
    async (preset?: string, promptOverride?: string) => {
      if (!draftId) return;
      const effectivePrompt = (promptOverride ?? prompt).trim();
      if (!effectivePrompt) return;
      setStreaming(true);
      setOutput("");
      setLog([]);
      setError(null);
      const ac = new AbortController();
      abortRef.current = ac;
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
          },
          (frame: AgentFrame) => {
            switch (frame.type) {
              case "start":
                setLog((L) => [
                  ...L,
                  {
                    kind: "start",
                    text: `${frame.provider} · v${frame.version}${frame.tracked ? " · tracked" : ""}${
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
    },
    [apiKey, draftId, effectiveModel, needsKey, onDraftUpdated, persona, prompt, provider],
  );

  useEffect(() => {
    if (!autoRun || !draftId || streaming) return;
    setPrompt(autoRun.prompt);
    void send(autoRun.preset, autoRun.prompt);
    onAutoRunConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, draftId]);

  function cancel() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60 p-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-zinc-500">Doc-grounded agent</div>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] text-zinc-400">Sprint 4</span>
      </div>

      {!draftId && (
        <p className="text-[11px] text-zinc-500">Open a draft to run the agent.</p>
      )}

      {draftId && (
        <>
          <div className="grid grid-cols-3 gap-1 text-[10px]">
            {(["mock", "gemini", "openai"] as Provider[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setProvider(p);
                  setModel("");
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
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={`${provider} API key (BYOK — not stored server-side)`}
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

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder={
              canRunAgent
                ? "Ask the agent to insert / modify sections using precedent (e.g. 'Add a payment milestones section based on the last CPGRAMS WO')."
                : "Read-only for this persona/status — the agent can search but not mutate."
            }
            className="mt-1.5 w-full rounded border border-zinc-700 bg-zinc-950 p-1.5 text-[11px] text-zinc-100 focus:border-blue-500 focus:outline-none"
          />

          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void send()}
              className="rounded bg-indigo-600 px-2 py-1 text-[11px] font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {streaming ? "…" : "Run agent"}
            </button>
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void send("precedent_weaver")}
              className="rounded border border-indigo-600 px-2 py-1 text-[10px] text-indigo-200 hover:bg-indigo-900/40 disabled:opacity-50"
              title="Preset: fetch a precedent doc and weave language into the draft"
            >
              Precedent Weaver
            </button>
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void send("redline_extender")}
              className="rounded border border-fuchsia-700 px-2 py-1 text-[10px] text-fuchsia-200 hover:bg-fuchsia-900/40 disabled:opacity-50"
              title="Preset: post tracked-change-style review threads (for L1/L2 reviewers)"
            >
              Redline Extender
            </button>
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
