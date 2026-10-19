import { notFound } from "next/navigation";
import SuperDocSpikeClient from "./SuperDocSpikeClient";

export const dynamic = "force-dynamic";

export default function SuperDocSpikePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SuperDocSpikeClient />;
}
