/**
 * Best-effort extraction of comment / tracked-change threads from a SuperDoc
 * editor instance so we can mirror them to the CFC threads table on save.
 *
 * SuperDoc's comment API surface is unstable across versions — we probe several
 * shapes and swallow errors. If nothing is found we return [] and the save
 * proceeds without any thread sync.
 */

type Maybe<T> = T | undefined | null;

type UnknownRecord = Record<string, unknown>;

export type ExtractedThread = {
  id: string;
  kind: "comment" | "tracked_change";
  anchor?: UnknownRecord | null;
  body: string;
  resolved: boolean;
  raw?: UnknownRecord;
  author_employee_id?: string | null;
};

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "object" && "text" in (v as UnknownRecord)) {
    const t = (v as UnknownRecord).text;
    if (typeof t === "string") return t;
  }
  try {
    return String(v);
  } catch {
    return "";
  }
}

function normalizeComment(raw: unknown, index: number): Maybe<ExtractedThread> {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as UnknownRecord;
  const id =
    (typeof r.id === "string" && r.id) ||
    (typeof r.commentId === "string" && r.commentId) ||
    (typeof r.threadId === "string" && r.threadId) ||
    `superdoc-c${index}`;
  const body =
    asString(r.body) ||
    asString(r.text) ||
    asString(r.content) ||
    asString((r.message as UnknownRecord | undefined)?.text) ||
    "";
  if (!body) return null;
  const resolved =
    r.resolved === true ||
    r.status === "resolved" ||
    r.state === "resolved";
  const anchor =
    (r.anchor as UnknownRecord | undefined) ||
    (r.range as UnknownRecord | undefined) ||
    (r.selection as UnknownRecord | undefined) ||
    null;
  const author =
    (typeof r.authorId === "string" && r.authorId) ||
    (typeof (r.author as UnknownRecord | undefined)?.id === "string"
      ? ((r.author as UnknownRecord).id as string)
      : null);
  return {
    id: String(id),
    kind: "comment",
    body,
    resolved,
    anchor,
    author_employee_id: author,
    raw: r,
  };
}

export function extractSuperDocThreads(instance: unknown): ExtractedThread[] {
  if (!instance || typeof instance !== "object") return [];
  const inst = instance as UnknownRecord;
  const results: ExtractedThread[] = [];

  const collect = (list: unknown) => {
    if (!Array.isArray(list)) return;
    list.forEach((raw, i) => {
      const t = normalizeComment(raw, results.length + i);
      if (t) results.push(t);
    });
  };

  try {
    const storage = (inst.activeEditor as UnknownRecord | undefined)?.storage as UnknownRecord | undefined;
    const commentsStore = storage?.comments as UnknownRecord | undefined;
    if (commentsStore) {
      if (typeof commentsStore.getAll === "function") {
        collect((commentsStore.getAll as () => unknown)());
      } else if (Array.isArray((commentsStore as UnknownRecord).all)) {
        collect((commentsStore as UnknownRecord).all);
      } else if (Array.isArray((commentsStore as UnknownRecord).items)) {
        collect((commentsStore as UnknownRecord).items);
      }
    }
  } catch {
    /* ignore */
  }

  try {
    if (typeof (inst as UnknownRecord).getComments === "function") {
      collect(((inst as UnknownRecord).getComments as () => unknown)());
    }
  } catch {
    /* ignore */
  }

  try {
    const query = ((inst.doc as UnknownRecord | undefined)?.query as UnknownRecord | undefined)?.threads as
      | UnknownRecord
      | undefined;
    if (query && typeof query.list === "function") {
      collect((query.list as () => unknown)());
    }
  } catch {
    /* ignore */
  }

  // Dedupe by id (multiple probes can surface the same thread).
  const seen = new Set<string>();
  return results.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

export async function bestEffortMirror(
  draftId: string,
  persona: "arpit" | "aashna" | "subroto" | "sg" | "admin",
  instance: unknown,
  syncFn: (
    draftId: string,
    persona: "arpit" | "aashna" | "subroto" | "sg" | "admin",
    threads: ExtractedThread[],
  ) => Promise<unknown>,
): Promise<{ synced: number; skipped: boolean }> {
  try {
    const threads = extractSuperDocThreads(instance);
    if (!threads.length) return { synced: 0, skipped: true };
    await syncFn(draftId, persona, threads);
    return { synced: threads.length, skipped: false };
  } catch {
    return { synced: 0, skipped: true };
  }
}
