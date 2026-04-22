"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { api, type FilterMetadata } from "@/lib/api";
import { Filter, RotateCcw, IndianRupee, Landmark } from "lucide-react";

interface SearchFiltersProps {
  onFiltersChange: (filters: SelectedFilters) => void;
}

export interface SelectedFilters {
  ministries: string[];
  minValue: number;
  maxValue: number;
}

export function SearchFilters({ onFiltersChange }: SearchFiltersProps) {
  const [metadata, setMetadata] = useState<FilterMetadata | null>(null);
  const [selectedMinistries, setSelectedMinistries] = useState<string[]>([]);
  const [valueRange, setValueRange] = useState<[number, number]>([0, 100000000]);

  useEffect(() => {
    api.getSearchFilters().then((data) => {
      setMetadata(data);
      setValueRange([data.value_range.min, data.value_range.max]);
    });
  }, []);

  const handleMinistryToggle = (ministry: string) => {
    setSelectedMinistries((prev) =>
      prev.includes(ministry)
        ? prev.filter((m) => m !== ministry)
        : [...prev, ministry]
    );
  };

  const handleReset = () => {
    setSelectedMinistries([]);
    if (metadata) {
      setValueRange([metadata.value_range.min, metadata.value_range.max]);
    }
  };

  useEffect(() => {
    onFiltersChange({
      ministries: selectedMinistries,
      minValue: valueRange[0],
      maxValue: valueRange[1],
    });
  }, [selectedMinistries, valueRange, onFiltersChange]);

  if (!metadata) return null;

  return (
    <Card className="glass border-white/5 h-full flex flex-col">
      <CardHeader className="py-4 border-b border-white/5 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <Filter size={14} className="text-primary" />
          Filters
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[10px] uppercase font-bold tracking-wider text-muted-foreground hover:text-foreground"
          onClick={handleReset}
        >
          <RotateCcw size={10} className="mr-1" />
          Reset
        </Button>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <ScrollArea className="h-full">
          <div className="p-6 space-y-8">
            {/* Ministry Filter */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/70">
                <Landmark size={12} />
                Ministries
              </div>
              <div className="space-y-3">
                {metadata.ministries.map((ministry) => (
                  <div key={ministry} className="flex items-start gap-3">
                    <Checkbox
                      id={`m-${ministry}`}
                      checked={selectedMinistries.includes(ministry)}
                      onCheckedChange={() => handleMinistryToggle(ministry)}
                      className="mt-1 border-white/20 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                    />
                    <Label
                      htmlFor={`m-${ministry}`}
                      className="text-xs font-medium leading-relaxed peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    >
                      {ministry}
                    </Label>
                  </div>
                ))}
              </div>
            </div>

            {/* Value Range Filter */}
            <div className="space-y-6">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground/70">
                <IndianRupee size={12} />
                Project Value (INR)
              </div>
              <div className="px-2">
                <Slider
                  min={metadata.value_range.min}
                  max={metadata.value_range.max}
                  step={100000}
                  value={valueRange}
                  onValueChange={(val) => setValueRange(val as [number, number])}
                  className="[&_[role=slider]]:h-4 [&_[role=slider]]:w-4"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 p-2 rounded-lg bg-white/5 border border-white/10 text-center">
                  <p className="text-[9px] uppercase font-bold text-muted-foreground mb-1">Min</p>
                  <p className="text-[11px] font-mono">₹{(valueRange[0] / 10000000).toFixed(2)} Cr</p>
                </div>
                <div className="flex-1 p-2 rounded-lg bg-white/5 border border-white/10 text-center">
                  <p className="text-[9px] uppercase font-bold text-muted-foreground mb-1">Max</p>
                  <p className="text-[11px] font-mono">₹{(valueRange[1] / 10000000).toFixed(2)} Cr</p>
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
