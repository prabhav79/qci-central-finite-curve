const API = process.env.CFC_API_BASE || "http://127.0.0.1:8000";
const WORKER = process.env.CFC_DOC_WORKER_BASE || "http://127.0.0.1:8100";

async function j(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method || "GET"} ${url} -> ${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

async function main() {
  console.log(await j(`${API}/health`));
  console.log(await j(`${API}/integrations/health`));

  let workerOk = false;
  try {
    console.log(await j(`${WORKER}/health`));
    workerOk = true;
  } catch (e) {
    console.warn("doc-worker not up:", e.message);
  }

  // -------- happy path --------
  const draft = await j(`${API}/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
    body: JSON.stringify({ title: "Smoke draft", maker_employee_id: "6281" }),
  });
  const id = draft.draft.id;
  console.log("created", id, draft.session.document_mode);

  const submitted = await j(`${API}/drafts/${id}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
    body: "{}",
  });
  console.log("submitted", submitted.session.status);

  const l1 = await j(`${API}/drafts/${id}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "1820" },
    body: JSON.stringify({ level: 1, decision: "approve", comments: "smoke l1" }),
  });
  console.log("l1", l1.draft.status);

  const l2 = await j(`${API}/drafts/${id}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "1052" },
    body: JSON.stringify({ level: 2, decision: "approve", comments: "smoke l2" }),
  });
  console.log("l2", l2.draft.status, (l2.draft.final_sha256 || "").slice(0, 12));

  // -------- reject-with-comment path --------
  const draft2 = await j(`${API}/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
    body: JSON.stringify({ title: "Smoke reject", maker_employee_id: "6281" }),
  });
  const rid = draft2.draft.id;
  await j(`${API}/drafts/${rid}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
    body: "{}",
  });

  // Empty comment must 400
  let rejected400 = false;
  try {
    await j(`${API}/drafts/${rid}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CFC-User": "1820" },
      body: JSON.stringify({ level: 1, decision: "reject", comments: "   " }),
    });
  } catch (e) {
    rejected400 = /-> 400/.test(e.message);
  }
  assert(rejected400, "reject with empty comment should return 400");
  console.log("reject-empty-comment 400 OK");

  // Reject with real comment succeeds and creates a review thread
  const rejectRes = await j(`${API}/drafts/${rid}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "1820" },
    body: JSON.stringify({
      level: 1,
      decision: "reject",
      comments: "Please expand the payment milestones section.",
      anchor: { section_hint: "payment_milestones" },
    }),
  });
  assert(rejectRes.draft.status === "REJECTED", `expected REJECTED, got ${rejectRes.draft.status}`);
  console.log("l1 reject OK", rejectRes.draft.status);

  // Fetch threads — expect at least one review_reason thread by 1820
  const threads = await j(`${API}/drafts/${rid}/threads`, {
    headers: { "X-CFC-User": "6281" },
  });
  const review = (threads.threads || []).find((t) => t.kind === "review_reason");
  assert(review, "expected a review_reason thread after reject");
  assert(review.author_employee_id === "1820", "reject thread should be authored by 1820");
  assert(/payment milestones/i.test(review.body), "review reason body should carry the comment");
  console.log("review thread OK", review.id, review.author_name);

  // Maker adds their own comment
  const cmt = await j(`${API}/drafts/${rid}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
    body: JSON.stringify({ kind: "comment", body: "Working on it — will resubmit tomorrow." }),
  });
  console.log("maker comment OK", cmt.id);

  // Resolve the review thread
  const patched = await j(`${API}/drafts/${rid}/threads/${review.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
    body: JSON.stringify({ resolved: true }),
  });
  assert(patched.resolved === true, "thread should be resolved");
  console.log("thread resolved OK");

  // Approvals inbox should now list nothing for Aashna (draft is REJECTED, awaits maker)
  const inbox = await j(`${API}/approvals/inbox`, { headers: { "X-CFC-User": "1820" } });
  const stillHere = (inbox.items || []).some((i) => i.draft.id === rid);
  assert(!stillHere, "REJECTED draft should be off Aashna's inbox");
  console.log("inbox scoping OK");

  // Resubmit and approve to FINAL to close the loop
  await j(`${API}/drafts/${rid}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
    body: "{}",
  });
  await j(`${API}/drafts/${rid}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "1820" },
    body: JSON.stringify({ level: 1, decision: "approve", comments: "looks good now" }),
  });
  const rfinal = await j(`${API}/drafts/${rid}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "1052" },
    body: JSON.stringify({ level: 2, decision: "approve", comments: "final" }),
  });
  assert(rfinal.draft.status === "FINAL_APPROVED", "resubmit path should reach FINAL_APPROVED");
  console.log("resubmit -> final OK", rfinal.draft.status);

  // -------- division silo check --------
  const virendraInbox = await j(`${API}/approvals/inbox`, { headers: { "X-CFC-User": "1100" } });
  const sees = (virendraInbox.items || []).some((i) => i.draft.division_code === "PPID");
  assert(!sees, "Virendra (QCI l2, not apex/admin) must not see PPID drafts");
  console.log("silo ACL OK");

  if (workerOk) {
    const seeded = await j(`${API}/drafts/from-worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
      body: JSON.stringify({ title: "Smoke worker draft" }),
    });
    console.log("worker draft", seeded.draft.id, "replaced=", seeded.worker?.replaced, "fallback=", seeded.worker?.fallback);
  }

  // -------- corpus + retrieval --------
  const stats = await j(`${API}/corpus/stats`, { headers: { "X-CFC-User": "6281" } });
  console.log("corpus", stats.documents, "docs /", stats.chunks, "chunks · backend =", stats.backend);
  const search = await j(`${API}/corpus/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
    body: JSON.stringify({ query: "CPGRAMS deliverables", limit: 3 }),
  });
  console.log("corpus hits", search.count, "backend=", search.backend);
  if (stats.backend === "db") {
    assert(search.count > 0, "DB search should return hits for a real corpus query");
    // Section-labeled retrieval sanity check
    const paySearch = await j(`${API}/corpus/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
      body: JSON.stringify({ query: "payment milestones schedule", limit: 3 }),
    });
    const sectionsSeen = new Set((paySearch.hits || []).map((h) => h.section_label).filter(Boolean));
    console.log("payment query sections seen:", [...sectionsSeen]);
  }
  const rag = await j(`${API}/rag/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
    body: JSON.stringify({ query: "Summarize CPGRAMS PMU scope", limit: 4 }),
  });
  console.log("rag provider", rag.provider, "citations", (rag.citations || []).length);

  // -------- agent chat (mock provider — no key required) --------
  if (stats.backend === "db") {
    const draftForAgent = await j(`${API}/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
      body: JSON.stringify({ title: "Agent smoke draft" }),
    });
    const aid = draftForAgent.draft.id;
    const startVersion = draftForAgent.draft.current_version;
    const sseResp = await fetch(`${API}/drafts/${aid}/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CFC-User": "6281" },
      body: JSON.stringify({
        prompt: "Summarize CPGRAMS payment milestones and cite a precedent.",
        provider: "mock",
      }),
    });
    if (!sseResp.ok) throw new Error(`agent SSE ${sseResp.status} ${await sseResp.text()}`);
    const reader = sseResp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const frames = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try { frames.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
      }
    }
    const kinds = frames.reduce((m, f) => (m[f.type] = (m[f.type] || 0) + 1, m), {});
    console.log("agent frames:", kinds);
    assert(frames.some((f) => f.type === "start"), "agent should emit 'start'");
    assert(frames.some((f) => f.type === "tool_call" && f.name === "cfc_search_corpus"), "mock should call cfc_search_corpus");
    assert(frames.some((f) => f.type === "tool_call" && f.name === "cfc_propose_insert"), "mock should call cfc_propose_insert");
    assert(frames.some((f) => f.type === "draft_updated"), "mutation should emit draft_updated");
    assert(frames.some((f) => f.type === "done"), "agent should emit 'done'");

    const after = await j(`${API}/drafts/${aid}/versions`, { headers: { "X-CFC-User": "6281" } });
    assert(after.current_version > startVersion, `expected new version, got ${after.current_version}`);
    const agentVer = after.versions.find((v) => v.trigger === "agent_insert");
    assert(agentVer, "expected a version with trigger=agent_insert");
    console.log("agent draft version", agentVer.version, "trigger", agentVer.trigger);
  }

  // Cross-division ACL: Virendra (QCI l2, not apex/admin) should not see PPID chunks
  const virendraCorpus = await j(`${API}/corpus/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CFC-User": "1100" },
    body: JSON.stringify({ query: "CPGRAMS deliverables", limit: 3 }),
  });
  if (stats.backend === "db") {
    const ppidHits = (virendraCorpus.hits || []).filter((h) => h.division_code === "PPID").length;
    assert(ppidHits === 0, "Virendra (QCI) must not see PPID corpus chunks");
  }
  console.log("corpus ACL OK");

  console.log("SMOKE OK");
}

main().catch((e) => {
  console.error("SMOKE FAIL", e);
  process.exit(1);
});
