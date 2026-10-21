export const API_BASE =
  process.env.NEXT_PUBLIC_CFC_API_BASE?.replace(/\/$/, "") ||
  "http://127.0.0.1:8000";

export const DOC_WORKER_BASE =
  process.env.NEXT_PUBLIC_CFC_DOC_WORKER_BASE?.replace(/\/$/, "") ||
  "http://127.0.0.1:8100";

export type PersonaKey = "arpit" | "aashna" | "subroto" | "sg" | "admin";

export const PERSONAS: Record<
  PersonaKey,
  { label: string; header: string; blurb: string }
> = {
  arpit: {
    label: "Arpit Mathur (PM / Maker)",
    header: "6281",
    blurb: "Creates and edits drafts",
  },
  aashna: {
    label: "Aashna Arora (SPM / L1)",
    header: "1820",
    blurb: "Level-1 review in suggesting mode",
  },
  subroto: {
    label: "Subroto Ghosh (PA / L2)",
    header: "1052",
    blurb: "Level-2 final approval",
  },
  sg: {
    label: "Chakravarthy T. Kannan (SG)",
    header: "613",
    blurb: "Apex visibility",
  },
  admin: {
    label: "Prabhav Kumar Singh (Admin)",
    header: "8599",
    blurb: "System admin override",
  },
};

export type Provider = "mock" | "gemini" | "openai" | "anthropic";

// BYOK keys are remembered per provider in this browser only; there is no
// server-side key storage for user-supplied keys.
export function apiKeyStorageKey(p: Provider): string {
  return `cfc.agentApiKey.${p}`;
}

export function loadStoredApiKey(p: Provider): string {
  try {
    return window.localStorage.getItem(apiKeyStorageKey(p)) ?? "";
  } catch {
    return "";
  }
}

export function storeApiKey(p: Provider, value: string): void {
  try {
    if (value) {
      window.localStorage.setItem(apiKeyStorageKey(p), value);
    } else {
      window.localStorage.removeItem(apiKeyStorageKey(p));
    }
  } catch {
    // Private browsing / blocked storage: the key just won't persist.
  }
}

export class ApiError extends Error {
  status: number;
  detail?: string;
  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

const NETWORK_MESSAGE =
  "We couldn't reach the server. Please check your connection and try again.";

function isPlainSentence(s: string): boolean {
  return (
    s.length > 0 &&
    s.length <= 200 &&
    !/[{}<>[\]]|[A-Z0-9]+_[A-Z0-9_]+|Traceback|Exception|\bNone\b/.test(s)
  );
}

export function friendlyMessage(status: number, detail?: string): string {
  const plain = detail && isPlainSentence(detail) ? detail : undefined;
  if (status === 0) return NETWORK_MESSAGE;
  if (status === 401) return "Your session has ended. Please sign in again.";
  if (status === 403) return plain ?? "You don't have permission to do that.";
  if (status === 404) return "We couldn't find that. It may have been moved or deleted.";
  if (status === 409) return "This document was changed by someone else. Please reload and try again.";
  if (status === 413) return "That file is too large to upload.";
  if (status === 429) return "Too many requests just now. Please wait a minute and try again.";
  if (status >= 500) return "Something went wrong on our side. Please try again shortly.";
  return plain ?? "That didn't work. Please check and try again.";
}

export async function friendlyError(res: Response): Promise<ApiError> {
  let detail: string | undefined;
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown };
      const d = body?.detail ?? body?.message ?? body?.error;
      if (typeof d === "string") detail = d;
    } catch {
      // Not JSON: fall back to the status-based sentence.
    }
  } catch {
    // Body unreadable: same fallback.
  }
  return new ApiError(friendlyMessage(res.status, detail), res.status, detail);
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return NETWORK_MESSAGE;
  if (e instanceof Error && e.message) return e.message;
  return "Something went wrong. Please try again.";
}

export function isUnauthorized(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

export type AuthConfig = {
  auth_mode: string;
  access_code_required: boolean;
  email_delivery: "email" | "link" | string;
};

// X-CFC-User only identifies the caller in "personas" mode. In "magic-link"
// mode the backend ignores it for identity but still keys rate limits on it,
// so sending it there would put every user into one shared bucket.
let knownAuthMode: string | null = null;
let authModePromise: Promise<string> | null = null;

export function rememberAuthMode(mode: string | null | undefined): void {
  if (!mode) return;
  knownAuthMode = mode;
  authModePromise = Promise.resolve(mode);
}

async function resolveAuthMode(): Promise<string> {
  if (knownAuthMode) return knownAuthMode;
  if (!authModePromise) {
    authModePromise = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/config`, { cache: "no-store" });
        if (res.ok) {
          const cfg = (await res.json()) as Partial<AuthConfig>;
          if (cfg.auth_mode) {
            knownAuthMode = cfg.auth_mode;
            return cfg.auth_mode;
          }
        }
        if (res.status === 404) {
          knownAuthMode = "personas";
          return "personas";
        }
      } catch {
        // Fall through without caching so the next request retries.
      }
      authModePromise = null;
      return "personas";
    })();
  }
  return authModePromise;
}

async function identityHeaders(persona: PersonaKey | null): Promise<Record<string, string>> {
  if (!persona) return {};
  const mode = await resolveAuthMode();
  return mode === "magic-link" ? {} : { "X-CFC-User": PERSONAS[persona].header };
}

async function send(
  path: string,
  persona: PersonaKey | null,
  init: RequestInit = {},
): Promise<Response> {
  const id = await identityHeaders(persona);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      credentials: "include",
      ...init,
      headers: { ...id, ...((init.headers as Record<string, string> | undefined) ?? {}) },
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw new ApiError(NETWORK_MESSAGE, 0);
  }
  if (!res.ok) throw await friendlyError(res);
  return res;
}

export type DraftSession = {
  draft_id: string;
  user: {
    id: string;
    name: string;
    email: string;
    designation?: string;
    cfc_role: string;
    division_code?: string | null;
  };
  superdoc_role: "editor" | "suggester" | "viewer";
  document_mode: "editing" | "suggesting" | "viewing";
  can_save: boolean;
  can_submit: boolean;
  can_decide_l1: boolean;
  can_decide_l2: boolean;
  can_run_agent_mutate?: boolean;
  agent_change_mode?: "tracked" | "direct";
  status: string;
  version: number;
  title?: string;
  division_code?: string;
  cross_division_view?: boolean;
  l1_employee_id?: string | null;
  l2_employee_id?: string | null;
  maker_employee_id?: string | null;
};

export type DraftRecord = {
  id: string;
  title?: string;
  status: string;
  /** Confidential: no AI help, nothing sent to outside services. */
  ai_restricted?: boolean;
  current_version: number;
  division_code?: string;
  maker_employee_id?: string;
  created_at?: string | null;
  updated_at?: string | null;
  versions?: Array<{
    version: number;
    trigger: string;
    sha256?: string;
    created_at: string;
    actor_employee_id?: string;
  }>;
  worker?: Record<string, unknown>;
  l1_decision?: DecisionRecord;
  l2_decision?: DecisionRecord;
  [key: string]: unknown;
};

export type DecisionRecord = {
  decision: "approve" | "reject" | "changes_requested";
  comments: string;
  at?: string | null;
  by?: string;
  version?: number;
};

export type ThreadRecord = {
  id: string;
  draft_id: string;
  division_code: string;
  kind: "comment" | "tracked_change" | "review_reason";
  anchor?: Record<string, unknown> | null;
  body: string;
  author_employee_id?: string | null;
  author_name?: string | null;
  resolved: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  raw?: Record<string, unknown> | null;
};

export type InboxItem = {
  draft: DraftRecord;
  session: DraftSession;
  maker_name?: string | null;
  latest_review_reason?: {
    id: string;
    body: string;
    author_employee_id?: string | null;
    author_name?: string | null;
    created_at?: string | null;
    resolved: boolean;
  } | null;
  open_threads: number;
};

export async function apiGet<T>(
  path: string,
  persona: PersonaKey = "arpit",
): Promise<T> {
  const res = await send(path, persona);
  return res.json() as Promise<T>;
}

export async function apiJson<T>(
  path: string,
  persona: PersonaKey,
  init: RequestInit,
): Promise<T> {
  const res = await send(path, persona, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  return res.json() as Promise<T>;
}

export async function createDraft(
  persona: PersonaKey,
  title: string,
  templateCode = "BLANK",
  opts?: {
    templateSource?: "catalog" | "corpus_doc";
    corpusDocId?: string;
    aiRestricted?: boolean;
    /** Reader highlights (the caller's own) this draft starts from. */
    referenceHighlightIds?: number[];
  },
) {
  return apiJson<{ draft: DraftRecord; session: DraftSession }>("/drafts", persona, {
    method: "POST",
    body: JSON.stringify({
      title,
      template_code: templateCode,
      template_source: opts?.templateSource ?? "catalog",
      corpus_doc_id: opts?.corpusDocId,
      ai_restricted: opts?.aiRestricted ?? false,
      reference_highlight_ids: opts?.referenceHighlightIds ?? [],
    }),
  });
}

export type GenerationTemplate = {
  template_code: string;
  label: string;
  description: string;
  outline: [string, string][];
};

export async function listGenerationTemplates(persona: PersonaKey) {
  return apiGet<{ items: GenerationTemplate[] }>("/generation/templates", persona);
}

export async function listDrafts(persona: PersonaKey) {
  return apiGet<{ items: Array<{ draft: DraftRecord; session: DraftSession }> }>(
    "/drafts",
    persona,
  );
}

export async function listVersions(draftId: string, persona: PersonaKey) {
  return apiGet<{
    draft_id: string;
    current_version: number;
    versions: DraftRecord["versions"];
  }>(`/drafts/${draftId}/versions`, persona);
}

export async function fetchDraftFile(
  draftId: string,
  persona: PersonaKey = "arpit",
): Promise<File> {
  const res = await send(`/drafts/${draftId}/file`, persona);
  const blob = await res.blob();
  return new File([blob], `${draftId}.docx`, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

export async function saveDraftFile(
  draftId: string,
  persona: PersonaKey,
  blob: Blob,
  trigger = "manual",
) {
  const form = new FormData();
  form.append(
    "file",
    new File([blob], `${draftId}.docx`, {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
  );
  const res = await send(`/drafts/${draftId}/file`, persona, {
    method: "PUT",
    headers: { "X-CFC-Save-Trigger": trigger },
    body: form,
  });
  return res.json() as Promise<{
    ok: boolean;
    version: number;
    session: DraftSession;
  }>;
}

export async function integrationsHealth() {
  return apiGet<{
    api: string;
    template_exists: boolean;
    doc_worker: { ok: boolean; error?: string; service?: string };
  }>("/integrations/health");
}

export type CorpusHit = {
  chunk_id: string;
  doc_id: string;
  title: string;
  ministry: string;
  date?: string | null;
  domains: string[];
  value_inr?: number;
  text: string;
  source: string;
  score: number;
  kind?: string;
  by_kind?: Record<string, number>;
  relevance?: number;
};

export async function corpusStats() {
  return apiGet<{
    documents: number;
    chunks: number;
    ministries: string[];
    by_kind?: Record<string, number>;
  }>("/corpus/stats");
}

export async function corpusSearch(query: string, limit = 8, persona: PersonaKey = "arpit") {
  return apiJson<{ query: string; count: number; hits: CorpusHit[] }>(
    "/corpus/search",
    persona,
    {
      method: "POST",
      body: JSON.stringify({ query, limit }),
    },
  );
}

export async function fetchApprovalsInbox(persona: PersonaKey) {
  return apiGet<{ items: InboxItem[] }>("/approvals/inbox", persona);
}

export async function fetchThreads(draftId: string, persona: PersonaKey) {
  return apiGet<{
    draft_id: string;
    count: number;
    open: number;
    threads: ThreadRecord[];
  }>(`/drafts/${draftId}/threads`, persona);
}

export async function createThread(
  draftId: string,
  persona: PersonaKey,
  body: {
    id?: string;
    kind?: "comment" | "tracked_change" | "review_reason";
    anchor?: Record<string, unknown> | null;
    body: string;
    raw?: Record<string, unknown> | null;
  },
) {
  return apiJson<ThreadRecord>(`/drafts/${draftId}/threads`, persona, {
    method: "POST",
    body: JSON.stringify({ kind: "comment", ...body }),
  });
}

export async function patchThread(
  draftId: string,
  threadId: string,
  persona: PersonaKey,
  body: {
    resolved?: boolean;
    body?: string;
    anchor?: Record<string, unknown> | null;
    raw?: Record<string, unknown> | null;
  },
) {
  return apiJson<ThreadRecord>(`/drafts/${draftId}/threads/${threadId}`, persona, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function syncThreads(
  draftId: string,
  persona: PersonaKey,
  threads: Array<{
    id: string;
    kind?: "comment" | "tracked_change" | "review_reason";
    anchor?: Record<string, unknown> | null;
    body?: string;
    resolved?: boolean;
    raw?: Record<string, unknown> | null;
    author_employee_id?: string | null;
  }>,
) {
  if (!threads.length) return { inserted: 0, updated: 0, total_incoming: 0 };
  return apiJson<{ inserted: number; updated: number; total_incoming: number }>(
    `/drafts/${draftId}/threads/sync`,
    persona,
    {
      method: "POST",
      body: JSON.stringify({
        threads: threads.map((t) => ({ kind: "comment", body: "", resolved: false, ...t })),
      }),
    },
  );
}

export async function decideDraft(
  draftId: string,
  persona: PersonaKey,
  args: {
    level: 1 | 2;
    decision: "approve" | "reject" | "changes_requested";
    comments?: string;
    anchor?: Record<string, unknown> | null;
  },
) {
  return apiJson<{ draft: DraftRecord; session: DraftSession }>(
    `/drafts/${draftId}/decide`,
    persona,
    {
      method: "POST",
      body: JSON.stringify({
        level: args.level,
        decision: args.decision,
        comments: args.comments ?? "",
        anchor: args.anchor ?? null,
      }),
    },
  );
}

export async function uploadCorpusFile(
  persona: PersonaKey,
  file: File,
  opts?: { title?: string; ministry?: string; domain?: string },
) {
  const form = new FormData();
  form.append("file", file);
  if (opts?.title) form.append("title", opts.title);
  if (opts?.ministry) form.append("ministry", opts.ministry);
  if (opts?.domain) form.append("domain", opts.domain);
  const res = await send("/corpus/uploads", persona, { method: "POST", body: form });
  return res.json() as Promise<{
    ok: boolean;
    storage_key: string;
    doc_id: string;
    chunks: number;
    division_code: string;
    changed: boolean;
  }>;
}

export type TemplateItem = {
  template_code: string;
  filename: string;
  path: string;
  bytes: number;
  modified_at: string;
};

export async function listTemplates(persona: PersonaKey) {
  return apiGet<{ count: number; items: TemplateItem[] }>("/corpus/templates", persona);
}

export async function uploadCorpusTemplate(
  persona: PersonaKey,
  file: File,
  templateCode: string,
) {
  const form = new FormData();
  form.append("file", file);
  form.append("template_code", templateCode);
  const res = await send("/corpus/templates", persona, { method: "POST", body: form });
  return res.json() as Promise<{ ok: boolean; template_code: string; path: string }>;
}

export async function reindexCorpus(persona: PersonaKey, force = false) {
  return apiJson<{ accepted: boolean; reason?: string; poll: string }>(
    `/corpus/reindex${force ? "?force=true" : ""}`,
    persona,
    { method: "POST", body: "{}" },
  );
}

export async function getReindexStatus(persona: PersonaKey) {
  return apiJson<{
    jobs: Record<string, number>;
    total: number;
    runpulse_pages_used_total: number;
    runpulse_page_cap: number | null;
  }>("/corpus/reindex/status", persona, { method: "GET" });
}

export async function reclassifyCorpus(persona: PersonaKey) {
  return apiJson<{ ok: boolean; documents: number; changed: number }>(
    "/corpus/reclassify",
    persona,
    { method: "POST", body: "{}" },
  );
}

export async function recomputeGraph(persona: PersonaKey) {
  return apiJson<{ ok: boolean; documents: number; edges_upserted: number }>(
    "/corpus/graph/recompute",
    persona,
    { method: "POST", body: "{}" },
  );
}

export type FlaggedDocument = {
  doc_id: string;
  title: string;
  ministry: string | null;
  division_code: string;
  kind: string;
  source_path: string;
  injection_flag: number;
};

export async function getFlaggedDocuments(persona: PersonaKey) {
  return apiGet<{ threshold: number; items: FlaggedDocument[] }>(
    "/corpus/flagged",
    persona,
  );
}

export type GraphNodeType = "ministry" | "domain" | "document";

export type GraphNode = {
  id: string;
  label: string;
  type: GraphNodeType;
  count: number | null;
  doc_id: string | null;
  kind: string | null;
  weight: number | null;
};

export type GraphChildrenResponse = {
  parent: string;
  nodes: GraphNode[];
};

export async function getGraphChildren(persona: PersonaKey, parent?: string) {
  const qs = parent ? `?parent=${encodeURIComponent(parent)}` : "";
  return apiJson<GraphChildrenResponse>(`/corpus/graph/children${qs}`, persona, {
    method: "GET",
  });
}

export type GraphPreviewCorpusDocument = {
  kind: "corpus_document";
  doc_id: string;
  title: string;
  ministry: string;
  domains: string[];
  date: string | null;
  text: string;
  source_kind: string;
};

export type GraphPreviewDraft = {
  kind: "draft";
  draft_id: string;
};

export type GraphPreviewResponse = GraphPreviewCorpusDocument | GraphPreviewDraft;

export async function getGraphPreview(persona: PersonaKey, docId: string) {
  return apiJson<GraphPreviewResponse>(
    `/corpus/graph/preview/${encodeURIComponent(docId)}`,
    persona,
    { method: "GET" },
  );
}

export type AgentErrorCode =
  | "auth"
  | "quota"
  | "rate_limit"
  | "provider"
  | "doc_worker"
  | "timeout"
  | "unknown";

export type AgentFrame =
  | { type: "start"; draft_id: string; version: number; providers: string[]; tracked: boolean; can_run_agent_mutate: boolean }
  | {
      type: "preset";
      name: string;
      max_turns?: number;
      sections?: { label: string; title: string }[];
    }
  | { type: "token"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: Record<string, unknown> }
  | { type: "draft_updated"; version: number; sha256: string; tracked: boolean }
  | { type: "section_start"; section: string; title: string }
  | { type: "section_result"; section: string; ok: boolean; error?: string | null }
  | {
      type: "faithfulness_flag";
      section: string;
      flags: {
        claim: string;
        score: number;
        /** The retrieved passage closest to the claim, to compare against. */
        source?: { doc_id: string; title: string; passage: string } | null;
      }[];
    }
  | {
      type: "ready_to_generate";
      enriched_brief?: string;
      key_docs?: { doc_id: string; title: string }[];
      rationale?: string;
    }
  | { type: "done"; reason: string; sections_generated?: string[]; sections_failed?: string[] }
  | { type: "error"; message: string; code?: AgentErrorCode | string };

export type AgentChatBody = {
  prompt: string;
  provider: string;
  api_key?: string;
  model?: string;
  preset?: string;
  preset_args?: Record<string, unknown>;
};

function parseSseEvent(raw: string): AgentFrame | null {
  const data = raw
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data) return null;
  try {
    return JSON.parse(data) as AgentFrame;
  } catch {
    return null;
  }
}

export async function streamAgentChat(
  draftId: string,
  persona: PersonaKey,
  body: AgentChatBody,
  onFrame: (frame: AgentFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await send(`/drafts/${draftId}/agent/chat`, persona, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.body) throw new ApiError(friendlyMessage(500), 500);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const drain = () => {
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const frame = parseSseEvent(raw);
      if (frame) onFrame(frame);
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, "\n");
    drain();
  }
  buf += dec.decode();
  drain();
  const tail = parseSseEvent(buf);
  if (tail) onFrame(tail);
}

export type DiffBlock = {
  tag: "equal" | "replace" | "delete" | "insert";
  a_range: [number, number];
  b_range: [number, number];
  a_lines: string[];
  b_lines: string[];
};

export type DiffResponse = {
  draft_id: string;
  from_version: number;
  to_version: number;
  a_line_count: number;
  b_line_count: number;
  blocks: DiffBlock[];
  stats: Record<string, number>;
};

export async function fetchDraftDiff(
  draftId: string,
  fromVersion: number,
  toVersion: number,
  persona: PersonaKey,
) {
  return apiGet<DiffResponse>(
    `/drafts/${draftId}/diff?from_version=${fromVersion}&to_version=${toVersion}`,
    persona,
  );
}

export type ServerLlm = {
  provider: string;
  model: string;
  label?: string;
};

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  designation?: string | null;
  cfc_role: string;
  division_code?: string | null;
  is_admin?: boolean;
  /** "personas": the X-CFC-User header drives identity (dev/demo).
   * "magic-link": only the session cookie counts. */
  auth_mode?: string;
  cross_division_read?: boolean;
  server_llm?: ServerLlm | null;
};

export function isPersonasMode(me: CurrentUser | null | undefined): boolean {
  return me?.auth_mode === "personas";
}

export async function getAuthConfig(): Promise<AuthConfig | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/config`, { cache: "no-store" });
    if (!res.ok) return null;
    const cfg = (await res.json()) as AuthConfig;
    rememberAuthMode(cfg.auth_mode);
    return cfg;
  } catch {
    return null;
  }
}

export async function requestMagicLink(
  email: string,
  accessCode?: string,
): Promise<{ ok: boolean; delivery?: string; link?: string }> {
  const code = accessCode?.trim();
  const res = await send("/auth/magic-link", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(code ? { email, access_code: code } : { email }),
  });
  return res.json();
}

export async function verifyMagicLink(
  token: string,
): Promise<{ ok: boolean; email: string; ttl_hours: number }> {
  const res = await send(`/auth/verify?token=${encodeURIComponent(token)}`, null);
  return res.json();
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // Signing out locally still proceeds to the login page.
  }
}

/** null when signed out (401/403); throws ApiError for anything else
 * (server down, network), so callers can tell the two apart. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/me`, {
      cache: "no-store",
      credentials: "include",
    });
  } catch {
    throw new ApiError(NETWORK_MESSAGE, 0);
  }
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw await friendlyError(res);
  const me = (await res.json()) as CurrentUser;
  rememberAuthMode(me.auth_mode);
  return me;
}

export async function ragQuery(
  persona: PersonaKey,
  query: string,
  opts?: { limit?: number; provider?: string; api_key?: string; draftId?: string | null },
) {
  return apiJson<{
    query: string;
    answer: string;
    provider: string;
    citations: CorpusHit[];
    error?: string | null;
    /** Set when no AI was used: switched off, or a confidential document. */
    notice?: string;
  }>("/rag/query", persona, {
    method: "POST",
    body: JSON.stringify({
      query,
      limit: opts?.limit ?? 6,
      provider: opts?.provider,
      api_key: opts?.api_key,
      draft_id: opts?.draftId ?? undefined,
    }),
  });
}

// --------------------------------------------------------------------------- //
// Reader: original documents, private highlights, excerpts into drafts
// --------------------------------------------------------------------------- //

export type LibraryDoc = {
  doc_id: string;
  title: string;
  client?: string | null;
  ministry?: string | null;
  state?: string | null;
  sector?: string | null;
  work_type?: string | null;
  engagement?: string | null;
  doc_type?: string | null;
  date?: string | null;
  value_inr?: number | null;
  outcome: "successful" | "unsuccessful" | "pending" | "unknown";
  /** "Won", "Not won", "Pending"; null when unknown. */
  outcome_label?: string | null;
};

export type ReaderDocument = {
  document: LibraryDoc;
  file_url: string;
  /** The rest of this document's engagement series, oldest first (empty when it stands alone). */
  series: LibraryDoc[];
  similar: LibraryDoc[];
};

/** A rectangle as fractions (0..1) of its page, so it fits any zoom. */
export type HighlightRect = { page: number; x: number; y: number; w: number; h: number };

export type ReaderHighlight = {
  id: number;
  doc_id: string;
  doc_title?: string | null;
  page: number;
  rects: HighlightRect[];
  quote: string;
  note?: string | null;
  created_at?: string | null;
};

export type InsertableDraft = { id: string; title: string; status: string; updated_at?: string | null };

export async function getReaderDocument(persona: PersonaKey, docId: string) {
  return apiGet<ReaderDocument>(`/reader/documents/${encodeURIComponent(docId)}`, persona);
}

/** What PDF.js needs to fetch a document with the caller's identity. */
export async function readerPdfSource(persona: PersonaKey, fileUrl: string) {
  return {
    url: `${API_BASE}${fileUrl}`,
    httpHeaders: await identityHeaders(persona),
    withCredentials: true,
  };
}

export async function listHighlights(persona: PersonaKey, docId?: string) {
  const q = docId ? `?doc_id=${encodeURIComponent(docId)}` : "";
  return apiGet<{ items: ReaderHighlight[] }>(`/reader/highlights${q}`, persona);
}

export async function createHighlight(
  persona: PersonaKey,
  body: { doc_id: string; page: number; rects: HighlightRect[]; quote: string; note?: string },
) {
  return apiJson<ReaderHighlight>("/reader/highlights", persona, { method: "POST", body: JSON.stringify(body) });
}

export async function updateHighlightNote(persona: PersonaKey, id: number, note: string) {
  return apiJson<ReaderHighlight>(`/reader/highlights/${id}`, persona, {
    method: "PATCH",
    body: JSON.stringify({ note }),
  });
}

export async function deleteHighlight(persona: PersonaKey, id: number) {
  return apiJson<{ ok: boolean }>(`/reader/highlights/${id}`, persona, { method: "DELETE" });
}

export async function listInsertableDrafts(persona: PersonaKey) {
  return apiGet<{ items: InsertableDraft[] }>("/reader/my-drafts", persona);
}

/** Adds highlights to the end of a draft, each quoted with its source, as one new version. */
export async function addExcerptToDraft(persona: PersonaKey, draftId: string, highlightIds: number | number[]) {
  const ids = Array.isArray(highlightIds) ? highlightIds : [highlightIds];
  return apiJson<{ ok: boolean; version: number; draft: { id: string; title: string } }>(
    `/drafts/${encodeURIComponent(draftId)}/excerpts`,
    persona,
    { method: "POST", body: JSON.stringify({ highlight_ids: ids }) },
  );
}

// --------------------------------------------------------------------------- //
// Library: the corpus as documents, searched and filtered, won work first
// --------------------------------------------------------------------------- //

export const LIBRARY_FIELDS = ["outcome", "work_type", "sector", "client", "doc_type", "year", "state"] as const;
export type LibraryField = (typeof LIBRARY_FIELDS)[number];

export type LibraryResult = LibraryDoc & { snippet?: string; section?: string | null };

export type LibraryResponse = {
  query: string;
  total: number;
  items: LibraryResult[];
  facets: Record<LibraryField, { value: string; label: string; count: number }[]>;
  /** Rows are sectors, columns are types of work. */
  grid: { rows: string[]; cols: string[]; cells: Record<string, Record<string, { count: number; won: number }>> };
  engagements: { engagement: string; client?: string | null; documents: LibraryDoc[] }[];
};

export async function libraryDocuments(
  persona: PersonaKey,
  opts: { q?: string; filters?: Partial<Record<LibraryField, string[]>>; sort?: string; wonFirst?: boolean },
) {
  const params = new URLSearchParams();
  if (opts.q?.trim()) params.set("q", opts.q.trim());
  for (const [field, values] of Object.entries(opts.filters ?? {})) {
    for (const v of values ?? []) params.append(field, v);
  }
  if (opts.sort) params.set("sort", opts.sort);
  if (opts.wonFirst === false) params.set("won_first", "false");
  return apiGet<LibraryResponse>(`/library/documents?${params.toString()}`, persona);
}
