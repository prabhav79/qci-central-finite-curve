"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { 
  Sparkles, 
  Settings2, 
  Send,
  Zap,
  Info
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DocType } from "@/lib/api";
import { 
  Tooltip, 
  TooltipContent, 
  TooltipTrigger, 
  TooltipProvider 
} from "@/components/ui/tooltip";

export function GenerateForm({ 
  onGenerate, 
  loading 
}: { 
  onGenerate: (prompt: string, docType: DocType) => void;
  loading: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [docType, setDocType] = useState<DocType>("work_order");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (prompt.trim().length < 10 || loading) return;
    onGenerate(prompt, docType);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Sparkles className="text-primary w-5 h-5" />
              What are we drafting today?
            </h2>
            <p className="text-muted-foreground text-sm">
              describe the requirement and we'll cross-reference the institutional index.
            </p>
          </div>
          
          <div className="flex bg-white/5 p-1 rounded-xl border border-white/10 w-fit">
            <button
              type="button"
              onClick={() => setDocType("work_order")}
              className={cn(
                "px-4 py-1.5 rounded-lg text-sm font-semibold transition-all duration-300",
                docType === "work_order" 
                  ? "bg-primary text-primary-foreground shadow-md" 
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Work Order
            </button>
            <button
              type="button"
              onClick={() => setDocType("proposal")}
              className={cn(
                "px-4 py-1.5 rounded-lg text-sm font-semibold transition-all duration-300",
                docType === "proposal" 
                  ? "bg-primary text-primary-foreground shadow-md" 
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Proposal
            </button>
          </div>
        </div>

        <div className="relative group">
          <Textarea
            placeholder="e.g., Setting up a PMU for CPGRAMS with 3 resource persons for one year at DARPG..."
            className="min-h-[200px] bg-card/40 backdrop-blur-sm border-white/5 focus:border-primary/50 text-lg p-6 rounded-2xl resize-none transition-all group-hover:border-white/10"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={loading}
          />
          <div className="absolute bottom-4 right-4 flex items-center gap-3">
             <span className={cn(
               "text-[10px] font-bold tracking-widest uppercase",
               prompt.length < 10 ? "text-muted-foreground/40" : "text-primary"
             )}>
               {prompt.length} / 4000
             </span>
             <TooltipProvider>
               <Tooltip>
                 <TooltipTrigger render={<Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" />}>
                   <Info size={16} />
                 </TooltipTrigger>
                 <TooltipContent className="glass border-white/10 text-xs max-w-[200px]">
                   A more detailed prompt leads to better grounding in prior QCI work.
                 </TooltipContent>
               </Tooltip>
             </TooltipProvider>
          </div>
        </div>
      </div>

      <div className="flex flex-col md:flex-row items-center gap-4">
        <Button
          type="submit"
          className="w-full md:w-auto px-8 h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-xl shadow-lg shadow-primary/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 gap-2 overflow-hidden relative"
          disabled={loading || prompt.trim().length < 10}
        >
          {loading ? (
            <div className="flex items-center gap-3">
              <Zap className="w-5 h-5 animate-pulse text-white/50" />
              <span>Retrieving & Processing...</span>
            </div>
          ) : (
            <>
              Generate First Draft
              <Send size={18} />
            </>
          )}
        </Button>

        <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium">
          <Settings2 size={14} />
          Top-k: 8 Chunks · Gemini 1.5 Flash
        </div>
      </div>
    </form>
  );
}
