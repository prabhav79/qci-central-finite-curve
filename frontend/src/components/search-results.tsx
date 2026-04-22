"use client";

import { motion, AnimatePresence } from "framer-motion";
import { SourceChip } from "./source-chip";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, Building2, SearchX } from "lucide-react";
import type { RetrievedChunk } from "@/lib/api";

interface SearchResultsProps {
  results: RetrievedChunk[];
  loading: boolean;
  query: string;
}

export function SearchResults({ results, loading, query }: SearchResultsProps) {
  if (loading && items.length === 0) {
     return (
        <div className="space-y-4">
           {[1,2,3,4].map(i => (
              <Card key={i} className="glass border-white/5 overflow-hidden animate-pulse">
                <CardContent className="p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="h-4 w-1/3 bg-white/10 rounded" />
                    <div className="h-4 w-12 bg-white/10 rounded" />
                  </div>
                  <div className="space-y-2">
                    <div className="h-3 w-full bg-white/5 rounded" />
                    <div className="h-3 w-5/6 bg-white/5 rounded" />
                  </div>
                </CardContent>
              </Card>
           ))}
        </div>
     );
  }

  if (!loading && results.length === 0 && query) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center py-20 text-center space-y-4 border-2 border-dashed border-white/5 rounded-3xl bg-white/[0.01]"
      >
        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center text-muted-foreground/30">
          <SearchX size={32} />
        </div>
        <div className="space-y-1">
          <h3 className="font-semibold text-foreground/60 text-lg">No matches found</h3>
          <p className="text-sm text-muted-foreground/40 max-w-xs mx-auto">
            Try adjusting your filters or using different keywords for your institutional query.
          </p>
        </div>
      </motion.div>
    );
  }

  return (
    <div className="space-y-4">
      <AnimatePresence mode="popLayout">
        {results.map((result, i) => (
          <motion.div
            key={`${result.document_id}-${result.chunk_index}`}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ delay: i * 0.05 }}
          >
            <Card className="glass border-white/5 hover:border-primary/20 transition-all duration-300 group">
              <CardContent className="p-6 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Building2 size={12} className="text-primary/60" />
                      <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                        {result.ministry || "General QCI"}
                      </span>
                    </div>
                    <h3 className="font-bold text-sm leading-tight text-foreground/90 group-hover:text-primary transition-colors">
                      {result.project || result.doc_id}
                    </h3>
                  </div>
                  <Badge variant="secondary" className="bg-primary/10 text-primary border-none text-[10px] h-6">
                    {Math.round(result.similarity * 100)}% Match
                  </Badge>
                </div>

                <div className="relative">
                   <p className="text-sm leading-relaxed text-muted-foreground line-clamp-3 italic">
                     &ldquo;{result.text}&rdquo;
                   </p>
                   {/* Gradient fade for long text */}
                   <div className="absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background/50 to-transparent pointer-events-none" />
                </div>

                <div className="pt-2 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                      <Calendar size={12} />
                      {result.issued_on ? result.issued_on.split('T')[0] : "N/A"}
                    </span>
                  </div>
                  <SourceChip source={result} />
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

const items = [1]; // Helper for skeletons
