"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SourceChip } from "./source-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { 
  Download, 
  Edit3, 
  Copy, 
  Check, 
  FileText, 
  Clock, 
  Cpu, 
  ArrowRight
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { GenerateResponse } from "@/lib/api";
import { api } from "@/lib/api";

export function DraftViewer({ 
  generation, 
  onEdit 
}: { 
  generation: GenerateResponse;
  onEdit: () => void;
}) {
  const [copying, setCopying] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(generation.draft_md);
      setCopying(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopying(false), 2000);
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await api.exportDocx(generation.id);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `QCI_${generation.doc_type}_${generation.id.slice(0, 8)}.docx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success("Document exported successfully");
    } catch (err) {
      toast.error("Export failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setExporting(false);
    }
  };

  // Custom component for markdown to render [source: doc_id] as chips
  const MarkdownComponents = {
    // We handle text that contains the source pattern
    p: ({ children }: any) => {
      if (typeof children === 'string' || (Array.isArray(children) && children.every(c => typeof c === 'string'))) {
        const text = Array.isArray(children) ? children.join('') : children;
        const parts = text.split(/(\[source:\s*[^\]]+\])/g);
        
        return (
          <p className="mb-4 leading-relaxed">
            {parts.map((part: string, i: number) => {
              const match = part.match(/\[source:\s*([^\]]+)\]/);
              if (match) {
                const docId = match[1].trim();
                const source = generation.sources.find(s => s.doc_id === docId);
                if (source) {
                  return <SourceChip key={i} source={source} />;
                }
              }
              return part;
            })}
          </p>
        );
      }
      return <p className="mb-4 leading-relaxed">{children}</p>;
    }
  };

  return (
    <Card className="glass border-white/5 shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-700">
      <CardHeader className="bg-primary/5 py-3 border-b border-white/5 flex flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <FileText size={18} />
          </div>
          <div>
            <CardTitle className="text-lg font-bold">Generated {generation.doc_type.replace('_', ' ')}</CardTitle>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
              <span className="flex items-center gap-1"><Cpu size={10} /> {generation.model_used.split('/').pop()}</span>
              <span className="flex items-center gap-1"><Clock size={10} /> {new Date().toLocaleTimeString()}</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 bg-white/5 gap-2 px-3" onClick={handleCopy}>
            {copying ? <Check size={14} /> : <Copy size={14} />}
            {copying ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" className="h-8 gap-2 px-3" onClick={onEdit}>
            <Edit3 size={14} />
            Edit
          </Button>
        </div>
      </CardHeader>
      
      <CardContent className="p-8 prose prose-invert max-w-none">
        <ReactMarkdown 
          remarkPlugins={[remarkGfm]}
          components={MarkdownComponents as any}
        >
          {generation.draft_md}
        </ReactMarkdown>
      </CardContent>

      <Separator className="bg-white/5" />

      <CardFooter className="bg-primary/5 p-4 flex items-center justify-between">
        <div className="flex gap-2">
          {generation.sources.slice(0, 3).map((s, i) => (
            <Badge key={i} variant="secondary" className="bg-white/5 text-[9px] hover:bg-white/10 transition-colors">
              Ref: {s.doc_id.split('_')[0]}
            </Badge>
          ))}
          {generation.sources.length > 3 && (
            <Badge variant="secondary" className="bg-white/5 text-[9px]">
              +{generation.sources.length - 3} more
            </Badge>
          )}
        </div>

        <Button 
          className="font-bold gap-2 px-6 shadow-xl shadow-primary/10 hover:shadow-primary/20 transition-all hover:scale-[1.02]"
          onClick={handleExport}
          disabled={exporting}
        >
          {exporting ? (
            <span className="flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              Exporting...
            </span>
          ) : (
            <>
              Export to Word (.docx)
              <Download size={16} />
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}
