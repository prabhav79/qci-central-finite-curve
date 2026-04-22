"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SearchFilters, type SelectedFilters } from "@/components/search-filters";
import { SearchResults as ResultsList } from "@/components/search-results";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2, Landmark, SlidersHorizontal } from "lucide-react";
import { isAuthenticated } from "@/lib/auth";
import { api, type RetrievedChunk } from "@/lib/api";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { useDebounce } from "@/hooks/use-debounce"; 

export default function SearchPage() {
  const [authorized, setAuthorized] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<RetrievedChunk[]>([]);
  const [filters, setFilters] = useState<SelectedFilters | null>(null);
  const router = useRouter();

  const debouncedQuery = useDebounce(query, 500);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.push("/");
    } else {
      setAuthorized(true);
    }
  }, [router]);

  const performSearch = useCallback(async (q: string, f: SelectedFilters | null) => {
    if (!q || q.length < 2) {
      setResults([]);
      return;
    }

    setLoading(true);
    try {
      const resp = await api.search({
        q,
        ministry: f?.ministries,
        min_value: f?.minValue,
        max_value: f?.maxValue,
      });
      setResults(resp.results);
    } catch (err) {
      toast.error("Search failed", {
        description: err instanceof Error ? err.message : "Internal engine error",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    performSearch(debouncedQuery, filters);
  }, [debouncedQuery, filters, performSearch]);

  if (!authorized) return null;

  return (
    <AppShell>
      <div className="flex h-full overflow-hidden">
        {/* Sidebar Filters */}
        <aside className="hidden lg:block w-80 p-6 border-r border-white/5 bg-background/50">
          <SearchFilters onFiltersChange={setFilters} />
        </aside>

        {/* Main Search Area */}
        <main className="flex-1 overflow-hidden flex flex-col">
          <header className="p-8 pb-4 space-y-6">
            <div className="space-y-1">
              <h1 className="text-2xl font-black tracking-tight flex items-center gap-2">
                <Search size={24} className="text-primary" />
                Interactive Search
              </h1>
              <p className="text-sm text-muted-foreground font-medium">
                Query the multi-dimensional index with semantic filters.
              </p>
            </div>

            <div className="relative group">
              <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-muted-foreground group-focus-within:text-primary transition-colors">
                {loading ? <Loader2 size={20} className="animate-spin" /> : <Search size={20} />}
              </div>
              <Input
                type="text"
                placeholder="Search for projects, deliverables, or ministry requirements..."
                className="pl-12 h-14 bg-white/5 border-white/5 focus:border-primary/50 text-lg rounded-2xl transition-all shadow-xl shadow-black/20"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            
            {/* Mobile Filters Trigger (Placeholder) */}
            <div className="lg:hidden flex gap-2">
               <Button variant="outline" size="sm" className="bg-white/5 gap-2">
                 <SlidersHorizontal size={14} />
                 Filters
               </Button>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto px-8 pb-12 custom-scrollbar">
            <div className="max-w-4xl mx-auto space-y-6">
              {results.length > 0 && (
                <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/60 py-2">
                  <span>Found {results.length} institutional matches</span>
                  <div className="flex gap-2">
                     {filters?.ministries.length && (
                        <span className="text-primary flex items-center gap-1">
                          <Landmark size={10} />
                          {filters.ministries.length} Filters
                        </span>
                     )}
                  </div>
                </div>
              )}
              
              <ResultsList 
                results={results} 
                loading={loading} 
                query={debouncedQuery} 
              />
            </div>
          </div>
        </main>
      </div>
    </AppShell>
  );
}
