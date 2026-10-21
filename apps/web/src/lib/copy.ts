import { PERSONAS, type DraftRecord } from "@/lib/cfcApi";
import { formatDateTimeIST } from "@/lib/dates";

const TRIGGER_LABELS: Record<string, string> = {
  create: "Created",
  manual: "Saved",
  agent_insert: "AI draft",
  agent_replace: "AI edit",
  worker_seed: "From template",
  fixture_load: "Imported",
  reader_excerpt: "Excerpt from the Reader",
};

export function versionLabel(v: NonNullable<DraftRecord["versions"]>[number]): string {
  const parts = [`Version ${v.version}`, TRIGGER_LABELS[v.trigger] ?? "Updated"];
  const when = formatDateTimeIST(v.created_at);
  if (when) parts.push(when);
  return parts.join(" · ");
}

const PERSONA_NAMES: Record<string, string> = Object.fromEntries(
  Object.values(PERSONAS).map((p) => [p.header, p.label.replace(/\s*\(.*\)\s*$/, "")]),
);

/** A person's display name; never shows a raw employee id. */
export function personName(name: string | null | undefined, employeeId?: string | null): string {
  if (name && name.trim()) return name.trim();
  if (employeeId && PERSONA_NAMES[employeeId]) return PERSONA_NAMES[employeeId];
  return "A colleague";
}

export function isEmptyUntitled(draft: DraftRecord): boolean {
  return /^untitled draft/i.test((draft.title ?? "").trim()) && (draft.current_version ?? 1) <= 1;
}

export function documentTitle(draft: Pick<DraftRecord, "title"> | null | undefined): string {
  return draft?.title?.trim() || "Untitled document";
}
