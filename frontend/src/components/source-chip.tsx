"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Info, ExternalLink } from "lucide-react";
import type { SourceRef } from "@/lib/api";

export function SourceChip({ source }: { source: SourceRef }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={
          <Badge
            variant="outline"
            className="cursor-help bg-primary/5 hover:bg-primary/10 border-primary/20 text-xs py-0.5 px-2 gap-1.5 transition-colors font-medium inline-flex items-center"
          />
        }>
          <span className="opacity-70">Source:</span>
          <span>{source.doc_id.split('_')[0] || source.doc_id}</span>
          <Info size={10} className="text-primary" />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs p-4 glass border-white/10 shadow-xl">
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-4">
              <h4 className="font-bold text-sm leading-tight text-primary">
                {source.doc_id}
              </h4>
              <Badge variant="secondary" className="text-[10px] h-4 px-1 shrink-0">
                {Math.round(source.similarity * 100)}% Match
              </Badge>
            </div>
            
            <Separator className="bg-white/5" />
            
            <div className="grid grid-cols-1 gap-2 text-[11px]">
              {source.ministry && (
                <div>
                  <span className="text-muted-foreground block uppercase text-[9px] font-bold tracking-wider">Ministry</span>
                  <span className="font-medium line-clamp-2">{source.ministry}</span>
                </div>
              )}
              {source.project && (
                <div>
                  <span className="text-muted-foreground block uppercase text-[9px] font-bold tracking-wider">Project</span>
                  <span className="font-medium line-clamp-2">{source.project}</span>
                </div>
              )}
              {source.issued_on && (
                <div>
                  <span className="text-muted-foreground block uppercase text-[9px] font-bold tracking-wider">Dated</span>
                  <span className="font-medium">{source.issued_on.split('T')[0]}</span>
                </div>
              )}
            </div>

            {source.blob_key && (
              <div className="pt-1">
                <Button variant="link" className="h-auto p-0 text-[10px] text-primary/80 hover:text-primary gap-1">
                  View PDF <ExternalLink size={10} />
                </Button>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
