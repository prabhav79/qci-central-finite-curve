"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function LoadingSkeleton() {
  return (
    <Card className="glass border-white/5 shadow-2xl overflow-hidden mt-8 animate-pulse">
      <CardHeader className="bg-primary/5 py-4 border-b border-white/5 flex flex-row items-center justify-between">
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-lg bg-white/10" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-48 bg-white/10" />
            <Skeleton className="h-3 w-32 bg-white/5" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-20 bg-white/10" />
          <Skeleton className="h-8 w-20 bg-white/10" />
        </div>
      </CardHeader>
      <CardContent className="p-8 space-y-6">
        <div className="space-y-3">
          <Skeleton className="h-8 w-full bg-white/10" />
          <Skeleton className="h-4 w-5/6 bg-white/5" />
          <Skeleton className="h-4 w-4/6 bg-white/5" />
        </div>
        
        <div className="space-y-4 pt-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-6 w-1/3 bg-white/10" />
              <Skeleton className="h-4 w-full bg-white/5" />
              <Skeleton className="h-4 w-full bg-white/5" />
              <Skeleton className="h-4 w-2/3 bg-white/5" />
            </div>
          ))}
        </div>
      </CardContent>
      <div className="bg-primary/5 p-4 flex items-center justify-between border-t border-white/5">
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full bg-white/5" />
          <Skeleton className="h-5 w-16 rounded-full bg-white/5" />
        </div>
        <Skeleton className="h-10 w-48 rounded-xl bg-white/10" />
      </div>
    </Card>
  );
}
