import { DocumentStudio } from "@/components/DocumentStudio";
import { PERSONAS, type PersonaKey } from "@/lib/cfcApi";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const initialDraftId = firstParam(params?.draft);
  const personaParam = firstParam(params?.persona);
  const initialPersona =
    personaParam && personaParam in PERSONAS ? (personaParam as PersonaKey) : undefined;
  return <DocumentStudio initialDraftId={initialDraftId} initialPersona={initialPersona} />;
}
