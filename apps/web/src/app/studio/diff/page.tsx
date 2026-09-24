import { DiffViewer } from "@/components/DiffViewer";
import { PERSONAS, type PersonaKey } from "@/lib/cfcApi";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function DiffPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const draft = firstParam(params?.draft) || "";
  const from = Number(firstParam(params?.from) || 1);
  const to = Number(firstParam(params?.to) || 2);
  const personaParam = firstParam(params?.persona);
  const persona =
    personaParam && personaParam in PERSONAS ? (personaParam as PersonaKey) : ("arpit" as PersonaKey);
  return <DiffViewer draftId={draft} fromVersion={from} toVersion={to} persona={persona} />;
}
