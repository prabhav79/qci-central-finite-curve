"use client";

import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { UploadCloud, FileIcon, X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FileDropzoneProps {
  onFilesSelected: (files: File[]) => void;
  loading?: boolean;
}

export function FileDropzone({ onFilesSelected, loading }: FileDropzoneProps) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const newFiles = [...selectedFiles, ...acceptedFiles];
    setSelectedFiles(newFiles);
  }, [selectedFiles]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    disabled: loading,
  });

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleUpload = () => {
    if (selectedFiles.length === 0) return;
    onFilesSelected(selectedFiles);
    setSelectedFiles([]);
  };

  return (
    <div className="space-y-6">
      <div
        {...getRootProps()}
        className={cn(
          "relative border-2 border-dashed rounded-3xl p-12 transition-all duration-300 flex flex-col items-center justify-center text-center cursor-pointer group",
          isDragActive 
            ? "border-primary bg-primary/5 shadow-2xl shadow-primary/5 scale-[1.01]" 
            : "border-white/5 bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]",
          loading && "opacity-50 cursor-not-allowed pointer-events-none"
        )}
      >
        <input {...getInputProps()} />
        <div className="w-20 h-20 rounded-3xl bg-primary/10 flex items-center justify-center text-primary mb-6 transition-transform group-hover:scale-110">
          <UploadCloud size={40} />
        </div>
        <div className="space-y-2">
          <h3 className="text-xl font-bold tracking-tight">Drop institutional documents here</h3>
          <p className="text-muted-foreground text-sm max-w-xs mx-auto font-medium">
            Drag & drop PDF work orders or proposals. We&apos;ll handle the OCR and indexing.
          </p>
        </div>
        
        <Badge variant="secondary" className="mt-8 bg-white/5 text-[10px] uppercase font-black tracking-widest py-1 border-white/5">
          PDF Only · Max 20MB per file
        </Badge>
      </div>

      {selectedFiles.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <div className="flex items-center justify-between px-2">
            <h4 className="text-xs font-black uppercase tracking-widest text-muted-foreground/60">
              Selected Documents ({selectedFiles.length})
            </h4>
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-7 text-[10px] font-bold text-destructive hover:bg-destructive/10"
              onClick={() => setSelectedFiles([])}
            >
              Clear All
            </Button>
          </div>

          <ScrollArea className="max-h-[300px]">
             <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-2">
                {selectedFiles.map((file, i) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5 group hover:border-primary/20 transition-all">
                    <div className="flex items-center gap-3 overflow-hidden">
                       <div className="p-2 rounded-lg bg-primary/10 text-primary">
                          <FileIcon size={16} />
                       </div>
                       <div className="overflow-hidden">
                          <p className="text-xs font-bold truncate pr-4">{file.name}</p>
                          <p className="text-[10px] text-muted-foreground uppercase">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                       </div>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-7 w-7 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => removeFile(i)}
                    >
                      <X size={14} />
                    </Button>
                  </div>
                ))}
             </div>
          </ScrollArea>

          <Button 
            className="w-full h-12 rounded-xl font-bold text-sm shadow-xl shadow-primary/20 gap-2 transition-all hover:scale-[1.01]"
            onClick={handleUpload}
            disabled={loading}
          >
            Start Institutional Ingestion
            <Plus size={18} />
          </Button>
        </motion.div>
      )}
    </div>
  );
}

import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import { ScrollArea } from "@/components/ui/scroll-area";
