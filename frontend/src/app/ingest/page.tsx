"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { FileDropzone } from "@/components/file-dropzone";
import { IngestProgress } from "@/components/ingest-progress";
import { isAuthenticated } from "@/lib/auth";
import { api, type IngestStatus } from "@/lib/api";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import { Inbox, History, Database, Sparkles } from "lucide-react";

export default function IngestPage() {
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<IngestStatus | null>(null);
  const router = useRouter();
  const pollInterval = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.push("/");
    } else {
      setAuthorized(true);
    }
  }, [router]);

  const startPolling = (jobId: string) => {
    if (pollInterval.current) clearInterval(pollInterval.current);
    
    pollInterval.current = setInterval(async () => {
      try {
        const data = await api.getIngestStatus(jobId);
        setStatus(data);
        
        if (data.finished_at) {
          if (pollInterval.current) clearInterval(pollInterval.current);
          setLoading(false);
          toast.success("Institutional ingestion complete!");
        }
      } catch (err) {
        console.error("Polling error:", err);
      }
    }, 2000);
  };

  useEffect(() => {
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, []);

  const handleIngest = async (files: File[]) => {
    setLoading(true);
    setStatus(null);
    try {
      const resp = await api.ingestFiles(files);
      setCurrentJobId(resp.id);
      toast.info("Upload complete. Beginning extraction...");
      startPolling(resp.id);
    } catch (err) {
      setLoading(false);
      toast.error("Ingestion failed to start", {
        description: err instanceof Error ? err.message : "Network error"
      });
    }
  };

  if (!authorized) return null;

  return (
    <AppShell>
      <div className="max-w-4xl mx-auto px-6 py-12 space-y-12">
         <header className="space-y-4 text-center">
            <motion.div
               initial={{ opacity: 0, scale: 0.9 }}
               animate={{ opacity: 1, scale: 1 }}
               className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-[10px] font-black uppercase tracking-widest border border-primary/20"
            >
               <Database size={12} />
               Institutional Memory Indexer
            </motion.div>
            <div className="space-y-2">
              <h1 className="text-4xl font-extrabold tracking-tight">Expand the <span className="text-primary italic">Finite</span> Curve</h1>
              <p className="text-muted-foreground max-w-xl mx-auto">
                Securely upload and index project documents. Our engine extracts structured metadata and 768-dimensional embeddings for high-fidelity RAG.
              </p>
            </div>
         </header>

         <AnimatePresence mode="wait">
           {!currentJobId ? (
             <motion.div
               key="dropzone"
               initial={{ opacity: 0, y: 20 }}
               animate={{ opacity: 1, y: 0 }}
               exit={{ opacity: 0, scale: 0.95 }}
             >
               <FileDropzone onFilesSelected={handleIngest} loading={loading} />
             </motion.div>
           ) : (
             <motion.div
               key="progress"
               initial={{ opacity: 0, y: 20 }}
               animate={{ opacity: 1, y: 0 }}
               className="space-y-6"
             >
               {status && <IngestProgress status={status} />}
               
               <div className="flex justify-center pt-8">
                  <Button 
                    variant="link" 
                    className="text-muted-foreground gap-2 font-bold uppercase tracking-widest text-[10px]"
                    onClick={() => setCurrentJobId(null)}
                  >
                    <Inbox size={14} />
                    New Ingestion Batch
                  </Button>
               </div>
             </motion.div>
           )}
         </AnimatePresence>

         <footer className="pt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/5 space-y-3">
               <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-primary"><Sparkles size={16} /></div>
               <h4 className="font-bold text-sm">Pulse Extraction</h4>
               <p className="text-[11px] text-muted-foreground leading-relaxed">SOC 2 compliant OCR identifies ministries, values, and dates automatically.</p>
            </div>
            <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/5 space-y-3">
               <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-primary"><History size={16} /></div>
               <h4 className="font-bold text-sm">Semantic Indexing</h4>
               <p className="text-[11px] text-muted-foreground leading-relaxed">Paragraph-aware chunking ensures context continuity for subsequent generation.</p>
            </div>
            <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/5 space-y-3">
               <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-primary"><Database size={16} /></div>
               <h4 className="font-bold text-sm">Versioning</h4>
               <p className="text-[11px] text-muted-foreground leading-relaxed">Automatic SHA256 deduplication prevents redundant memory allocation.</p>
            </div>
         </footer>
      </div>
    </AppShell>
  );
}

import { Button } from "@/components/ui/button";
