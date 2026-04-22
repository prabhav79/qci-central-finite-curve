"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  FileText, 
  CheckCircle2, 
  XCircle, 
  Loader2, 
  Clock,
  ExternalLink,
  ChevronRight
} from "lucide-react";
import type { IngestStatus, IngestItem } from "@/lib/api";

interface IngestProgressProps {
  status: IngestStatus;
}

export function IngestProgress({ status }: IngestProgressProps) {
  const percent = Math.round((status.completed / status.total_files) * 100);
  const isFinished = status.finished_at !== null;

  return (
    <Card className="glass border-white/5 overflow-hidden shadow-2xl">
      <CardHeader className="py-6 border-b border-white/5 bg-primary/5">
        <div className="flex items-center justify-between mb-4">
          <div className="space-y-1">
            <CardTitle className="text-xl font-black">Institutional Memory Ingestion</CardTitle>
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
               <Clock size={12} />
               Started {new Date(status.started_at).toLocaleTimeString()}
               {isFinished && ` · Finished at ${new Date(status.finished_at!).toLocaleTimeString()}`}
            </div>
          </div>
          <Badge variant={isFinished ? "default" : "secondary"} className="h-6 gap-1.5 font-bold uppercase tracking-widest text-[9px]">
            {isFinished ? (
               <>
                 <CheckCircle2 size={12} />
                 Complete
               </>
            ) : (
               <>
                 <Loader2 size={12} className="animate-spin" />
                 Processing
               </>
            )}
          </Badge>
        </div>
        
        <div className="space-y-2">
           <div className="flex justify-between text-xs font-bold">
              <span className="text-muted-foreground uppercase tracking-widest">Global Progress</span>
              <span>{percent}%</span>
           </div>
           <Progress value={percent} className="h-2 bg-white/5" />
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="divide-y divide-white/5">
          <AnimatePresence mode="popLayout">
            {status.items.map((item, i) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                className="p-4 flex items-center justify-between hover:bg-white/[0.01] transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className={`p-2.5 rounded-xl border ${
                    item.status === 'ready' ? 'bg-primary/10 border-primary/20 text-primary' :
                    item.status === 'failed' ? 'bg-destructive/10 border-destructive/20 text-destructive' :
                    'bg-white/5 border-white/10 text-muted-foreground'
                  }`}>
                    {item.status === 'processing' ? <Loader2 size={18} className="animate-spin" /> : <FileText size={18} />}
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-sm font-bold truncate max-w-[200px] sm:max-w-xs">{item.source_filename}</p>
                    <div className="flex items-center gap-2">
                       <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">
                         {item.status}
                       </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {item.status === 'failed' && (
                    <Badge variant="outline" className="text-destructive border-destructive/20 text-[9px] font-black uppercase">
                      {item.error || 'Unknown Error'}
                    </Badge>
                  )}
                  {item.status === 'ready' && (
                     <CheckCircle2 size={18} className="text-primary" />
                  )}
                  {item.status === 'processing' && (
                     <div className="text-[10px] text-primary font-black uppercase tracking-tighter animate-pulse">Scanning...</div>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </CardContent>
    </Card>
  );
}
