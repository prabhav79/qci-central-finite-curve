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
  current_version: number;
  division_code?: string;
  maker_employee_id?: string;
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

function headers(persona: PersonaKey, extra?: HeadersInit): HeadersInit {
  return {
    "X-CFC-User": PERSONAS[persona].header,
    ...extra,
  };
}

export async function apiGet<T>(
  path: string,
  persona: PersonaKey = "arpit",
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: headers(persona),
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export async function apiJson<T>(
  path: string,
  persona: PersonaKey,
  init: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...headers(persona, init.headers),
    },
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export async function createDraft(
  persona: PersonaKey,
  title: string,
  templateCode = "BLANK",
  opts?: { templateSource?: "catalog" | "corpus_doc"; corpusDocId?: string },
) {
  return apiJson<{ draft: DraftRecord; session: DraftSession }>("/drafts", persona, {
    method: "POST",
    body: JSON.stringify({
      title,
      template_code: templateCode,
      template_source: opts?.templateSource ?? "catalog",
      corpus_doc_id: opts?.corpusDocId,
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

export async function createDraftFromWorker(
  persona: PersonaKey,
  opts?: {
    title?: string;
    find?: string;
    replace?: string;
    tracked?: boolean;
  },
) {
  return apiJson<{
    draft: DraftRecord;
    session: DraftSession;
    worker: Record<string, unknown>;
  }>("/drafts/from-worker", persona, {
    method: "POST",
    body: JSON.stringify({
      title: opts?.title ?? "CPGRAMS PMU Extension — Worker Seeded",
      find: opts?.find ?? "Quality Council of India",
      replace:
        opts?.replace ?? "Quality Council of India (CFC Generated Draft)",
      tracked: opts?.tracked ?? true,
    }),
  });
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

export async function fetchDraftFile(draftId: string): Promise<File> {
  const res = await fetch(`${API_BASE}/drafts/${draftId}/file`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`File load failed: ${res.status}`);
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
  const res = await fetch(`${API_BASE}/drafts/${draftId}/file`, {
    method: "PUT",
    headers: {
      "X-CFC-User": PERSONAS[persona].header,
      "X-CFC-Save-Trigger": trigger,
    },
    body: form,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Save failed: ${res.status} ${await res.text()}`);
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
};

export async function corpusStats() {
  return apiGet<{
    documents: number;
    chunks: number;
    ministries: string[];
    by_kind?: Record<string, number>;
  }>("/corpus/stats");
}

export async function corpusSearch(query: string, limit = 8) {
  return apiJson<{ query: string; count: number; hits: CorpusHit[] }>(
    "/corpus/search",
    "arpit",
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
  const res = await fetch(`${API_BASE}/drafts/${draftId}/threads/${threadId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-CFC-User": PERSONAS[persona].header,
    },
    body: JSON.stringify(body),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<ThreadRecord>;
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
  const res = await fetch(`${API_BASE}/corpus/uploads`, {
    method: "POST",
    headers: { "X-CFC-User": PERSONAS[persona].header },
    body: form,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
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
  const res = await fetch(`${API_BASE}/corpus/templates`, {
    method: "POST",
    headers: { "X-CFC-User": PERSONAS[persona].header },
    body: form,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean; template_code: string; path: string }>;
}

export async function reindexCorpus(persona: PersonaKey) {
  return apiJson<{ stats: Record<string, number>; errors: string[] }>(
    "/corpus/reindex",
    persona,
    { method: "POST", body: "{}" },
  );
}

export type AgentFrame =
  | { type: "start"; draft_id: string; version: number; providers: string[]; tracked: boolean; can_run_agent_mutate: boolean }
  | { type: "preset"; name: string }
  | { type: "token"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: Record<string, unknown> }
  | { type: "draft_updated"; version: number; sha256: string; tracked: boolean }
  | { type: "section_start"; section: string; title: string }
  | { type: "section_result"; section: string; ok: boolean; error?: string | null }
  | { type: "done"; reason: string; sections_generated?: string[]; sections_failed?: string[] }
  | { type: "error"; message: string };

export async function streamAgentChat(
  draftId: string,
  persona: PersonaKey,
  body: {
    prompt: string;
    provider: string;
    api_key?: string;
    model?: string;
    preset?: string;
    preset_args?: Record<string, unknown>;
  },
  onFrame: (frame: AgentFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/drafts/${draftId}/agent/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CFC-User": PERSONAS[persona].header,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
    credentials: "include",
  });
  if (!res.ok || !res.body) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        const frame = JSON.parse(line.slice(5).trim()) as AgentFrame;
        onFrame(frame);
      } catch {
        // skip malformed
      }
    }
  }
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

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  designation?: string | null;
  cfc_role: string;
  division_code?: string | null;
  is_admin?: boolean;
};

export async function requestMagicLink(
  email: string,
): Promise<{ ok: boolean; delivery?: string; link?: string }> {
  const res = await fetch(`${API_BASE}/auth/magic-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export async function verifyMagicLink(
  token: string,
): Promise<{ ok: boolean; email: string; ttl_hours: number }> {
  const res = await fetch(
    `${API_BASE}/auth/verify?token=${encodeURIComponent(token)}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const res = await fetch(`${API_BASE}/me`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) return null;
  return res.json();
}

export async function ragQuery(
  persona: PersonaKey,
  query: string,
  opts?: { limit?: number; provider?: string; api_key?: string },
) {
  return apiJson<{
    query: string;
    answer: string;
    provider: string;
    citations: CorpusHit[];
    error?: string | null;
  }>("/rag/query", persona, {
    method: "POST",
    body: JSON.stringify({
      query,
      limit: opts?.limit ?? 6,
      provider: opts?.provider,
      api_key: opts?.api_key,
    }),
  });
}
