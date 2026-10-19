import type { ReactNode } from "react";

const EMPHASIS_RE = /\*\*(.+?)\*\*|\*(.+?)\*/g;

/** Renders the small bold/italic markdown subset the agent's conversational
 * text sometimes uses, despite being told not to (prompt compliance alone
 * is never reliable — same lesson this project already applied to DOCX
 * insertion, see apps/api/app/agent_tools.py's _add_markdown_runs). Without
 * this, emphasis markers show as literal asterisks in the chat UI. */
export function renderInlineEmphasis(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let pos = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  EMPHASIS_RE.lastIndex = 0;
  while ((match = EMPHASIS_RE.exec(text))) {
    if (match.index > pos) nodes.push(text.slice(pos, match.index));
    if (match[1] !== undefined) {
      nodes.push(<strong key={key++}>{match[1]}</strong>);
    } else {
      nodes.push(<em key={key++}>{match[2]}</em>);
    }
    pos = EMPHASIS_RE.lastIndex;
  }
  if (pos < text.length) nodes.push(text.slice(pos));
  return nodes;
}

const TABLE_RULE_RE = /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|(.*)\|\s*$/;

/** Plain rendering of a longer model answer that may still carry markdown:
 * headings lose their #, table rows become "a · b" lines (rule rows are
 * dropped), bold and italic render as such. Keep the container
 * `whitespace-pre-wrap` so line breaks and "-" bullets survive. */
export function renderAnswerText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  text
    .replace(/\r/g, "")
    .split("\n")
    .forEach((raw, i) => {
      if (TABLE_RULE_RE.test(raw)) return;
      const row = TABLE_ROW_RE.exec(raw);
      const line = row
        ? row[1].split("|").map((c) => c.trim()).filter(Boolean).join(" · ")
        : raw.replace(/^\s*#{1,6}\s+/, "");
      out.push(
        <span key={i}>
          {renderInlineEmphasis(line)}
          {"\n"}
        </span>,
      );
    });
  return out;
}
