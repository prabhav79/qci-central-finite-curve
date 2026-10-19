"use client";

import { type ServerLlm, loadStoredApiKey, storeApiKey } from "@/lib/cfcApi";
import {
  BYOK_PROVIDERS,
  PROVIDER_LABELS,
  type LlmChoice,
  type LlmProvider,
  choiceNeedsKey,
  serverLlmLabel,
} from "@/lib/llmChoice";

/** One provider picker shared by New document, the AI assistant panel and
 * the intake flow. Everyone sees the default; only admins get "Advanced". */
export function ModelPicker({
  choice,
  onChange,
  serverLlm,
  isAdmin,
  disabled,
}: {
  choice: LlmChoice;
  onChange: (next: LlmChoice) => void;
  serverLlm: ServerLlm | null | undefined;
  isAdmin: boolean;
  disabled?: boolean;
}) {
  const options: LlmProvider[] = [...(serverLlm ? (["server"] as const) : []), ...BYOK_PROVIDERS];
  const keyProvider =
    choice.provider !== "server" && choice.provider !== "mock" ? choice.provider : null;

  function select(p: LlmProvider) {
    onChange({
      provider: p,
      apiKey: p === "server" || p === "mock" ? "" : loadStoredApiKey(p),
      model: "",
    });
  }

  function label(p: LlmProvider): string {
    return p === "server" ? serverLlmLabel(serverLlm) : PROVIDER_LABELS[p];
  }

  return (
    <div className="text-[13px]">
      <p className="text-text-muted">
        {choice.provider === "mock" ? (
          "Test mode: placeholder text, no AI is used."
        ) : (
          <>
            Written by <span className="font-medium text-text">{label(choice.provider)}</span>
          </>
        )}
      </p>

      {keyProvider && (
        <input
          type="password"
          value={choice.apiKey}
          disabled={disabled}
          onChange={(e) => {
            storeApiKey(keyProvider, e.target.value);
            onChange({ ...choice, apiKey: e.target.value });
          }}
          placeholder="API key (saved in this browser only)"
          aria-label="API key"
          className="mt-1.5 w-full rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 font-mono text-xs text-text outline-none focus:border-accent disabled:opacity-50"
        />
      )}

      {isAdmin && (
        <details className="mt-1.5">
          <summary className="cursor-pointer select-none text-xs text-text-muted hover:text-text">
            Advanced
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {options.map((p) => (
              <button
                key={p}
                type="button"
                disabled={disabled}
                onClick={() => select(p)}
                aria-pressed={choice.provider === p}
                className={`rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
                  choice.provider === p
                    ? "bg-agent text-white"
                    : "bg-surface-sunken text-text-muted hover:text-text"
                }`}
              >
                {label(p)}
              </button>
            ))}
          </div>
          {choiceNeedsKey(choice) && (
            <input
              value={choice.model}
              disabled={disabled}
              onChange={(e) => onChange({ ...choice, model: e.target.value })}
              placeholder="Model (optional)"
              aria-label="Model"
              className="mt-1.5 w-full rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 text-xs text-text outline-none focus:border-accent disabled:opacity-50"
            />
          )}
        </details>
      )}
    </div>
  );
}
