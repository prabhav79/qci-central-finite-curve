"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { GenerateForm } from "@/components/generate-form";
import { DraftViewer } from "@/components/draft-viewer";
import { DraftEditor } from "@/components/draft-editor";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { isAuthenticated } from "@/lib/auth";
import { api, type DocType, type GenerateResponse } from "@/lib/api";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";

export default function GeneratePage() {
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState<GenerateResponse | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated()) {
      router.push("/");
    } else {
      setAuthorized(true);
    }
  }, [router]);

  const handleGenerate = async (prompt: string, docType: DocType) => {
    setLoading(true);
    setGeneration(null);
    try {
      const result = await api.generate(prompt, docType);
      setGeneration(result);
    } catch (err) {
      toast.error("Generation failed", {
        description: err instanceof Error ? err.message : "Internal engine error",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveEdit = (editedMarkdown: string) => {
    if (!generation) return;
    setGeneration({
      ...generation,
      draft_md: editedMarkdown
    });
    setIsEditing(false);
    toast.success("Changes saved locally", {
      description: "Note: Remote draft is not updated yet (Phase 0 constraint)."
    });
  };

  if (!authorized) return null;

  return (
    <AppShell>
      <div className="max-w-5xl mx-auto px-6 py-12 space-y-12">
        <header className="space-y-2">
          <motion.h1 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="text-4xl font-extrabold tracking-tight"
          >
            Creative <span className="text-primary italic">Finite</span> Engine
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 }}
            className="text-muted-foreground max-w-2xl"
          >
            Leveraging QCI&apos;s multidimensional institutional memory to draft high-fidelity Government engagement documents.
          </motion.p>
        </header>

        <section>
          <GenerateForm onGenerate={handleGenerate} loading={loading} />
        </section>

        <section className="relative min-h-[400px]">
          <AnimatePresence mode="wait">
            {loading && (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <LoadingSkeleton />
              </motion.div>
            )}

            {!loading && generation && !isEditing && (
              <motion.div
                key="viewer"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
              >
                <DraftViewer 
                  generation={generation} 
                  onEdit={() => setIsEditing(true)} 
                />
              </motion.div>
            )}

            {!loading && generation && isEditing && (
              <motion.div
                key="editor"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
              >
                <DraftEditor 
                  content={generation.draft_md}
                  onSave={handleSaveEdit}
                  onClose={() => setIsEditing(false)}
                />
              </motion.div>
            )}

            {!loading && !generation && (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center justify-center py-20 text-center space-y-4 rounded-3xl border-2 border-dashed border-white/5 bg-white/[0.01]"
              >
                <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center text-muted-foreground/40">
                  <span className="text-2xl font-bold">?</span>
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold text-foreground/60 tracking-tight text-lg">No Draft Active</h3>
                  <p className="text-sm text-muted-foreground/40 max-w-xs mx-auto">
                    Your generated and cross-referenced documents will appear here.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </div>
    </AppShell>
  );
}
