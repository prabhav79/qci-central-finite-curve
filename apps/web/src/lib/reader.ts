/** Links into the Reader, optionally at a passage it should find and mark. */
export function readerHref(docId: string, find?: string): string {
  const params = new URLSearchParams({ doc: docId });
  if (find) params.set("find", find);
  return `/studio/reader?${params.toString()}`;
}

const PLAIN_WORD = /^[\p{L}][\p{L}'’-]*[\p{L}]$|^[\p{L}]$/u;

/**
 * Five consecutive plain words from a passage, for the Reader to search the
 * PDF with. Numbers and symbols are skipped because extracted text and the
 * PDF's own text layer often differ there. With `near`, starts at the first
 * word containing one of those words (e.g. the search terms).
 */
export function passagePhrase(text: string, near: string[] = []): string {
  const tokens = text
    .replace(/…/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  const anchor = near.length
    ? tokens.findIndex((t) => near.some((w) => t.toLowerCase().includes(w)))
    : -1;
  // The first token may be cut mid-word, so plain runs start from the second.
  for (const start of anchor >= 0 ? [anchor, 1] : [1]) {
    for (let i = start; i + 5 <= tokens.length; i++) {
      const run = tokens.slice(i, i + 5);
      if (run.every((t) => PLAIN_WORD.test(t))) return run.join(" ");
    }
  }
  return "";
}
