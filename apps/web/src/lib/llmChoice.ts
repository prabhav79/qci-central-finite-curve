import {
  type AgentChatBody,
  type CurrentUser,
  type Provider,
  type ServerLlm,
  loadStoredApiKey,
} from "@/lib/cfcApi";

/** "server" = the model QCI runs with its own key (/me.server_llm); the
 * server picks the model, so nothing about it is sent from the browser. */
export type LlmProvider = "server" | Provider;

export type LlmChoice = { provider: LlmProvider; apiKey: string; model: string };

export const BYOK_PROVIDERS: Provider[] = ["anthropic", "openai", "gemini", "mock"];

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Claude (own key)",
  openai: "OpenAI (own key)",
  gemini: "Gemini (own key)",
  mock: "Test mode",
};

export function serverLlmLabel(server: ServerLlm | null | undefined): string {
  const label = (server?.label || server?.model || "").trim();
  if (!label) return "QCI's Claude";
  const short = label.replace(/^Claude\s+/i, "");
  return /^claude/i.test(label) ? `QCI's Claude (${short})` : `QCI's AI (${label})`;
}

export function defaultLlmChoice(me: CurrentUser | null | undefined): LlmChoice {
  if (me?.server_llm) return { provider: "server", apiKey: "", model: "" };
  return { provider: "anthropic", apiKey: loadStoredApiKey("anthropic"), model: "" };
}

export function choiceNeedsKey(choice: LlmChoice): boolean {
  return choice.provider !== "server" && choice.provider !== "mock";
}

export function choiceReady(choice: LlmChoice): boolean {
  return !choiceNeedsKey(choice) || Boolean(choice.apiKey.trim());
}

/** The provider/key/model part of an /agent/chat request. With the server
 * model, the server decides the model, so no model or key is sent. */
export function agentRequestFields(
  choice: LlmChoice,
): Pick<AgentChatBody, "provider" | "api_key" | "model"> {
  if (choice.provider === "server") return { provider: "auto" };
  if (choice.provider === "mock") return { provider: "mock" };
  return {
    provider: choice.provider,
    api_key: choice.apiKey.trim() || undefined,
    model: choice.model.trim() || undefined,
  };
}

export function missingKeyMessage(choice: LlmChoice): string {
  const name =
    choice.provider === "anthropic"
      ? "Claude"
      : choice.provider === "openai"
        ? "OpenAI"
        : choice.provider === "gemini"
          ? "Gemini"
          : "AI";
  return `Enter your ${name} API key to use the AI assistant.`;
}
