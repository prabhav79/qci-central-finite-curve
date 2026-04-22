"use client";

import { motion } from "framer-motion";
import { Hammer, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

interface ComingSoonProps {
  feature: string;
  description: string;
  icon: React.ElementType;
}

export function ComingSoon({ feature, description, icon: Icon }: ComingSoonProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] p-6 text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="w-24 h-24 rounded-3xl bg-primary/10 flex items-center justify-center text-primary mb-8 border border-primary/20 relative"
      >
        <Icon size={40} />
        <div className="absolute -top-2 -right-2 bg-background border border-white/10 rounded-full p-1.5 shadow-xl">
           <Hammer size={16} className="text-muted-foreground" />
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="space-y-4 max-w-md"
      >
        <div className="space-y-1">
          <Badge variant="secondary" className="uppercase tracking-widest text-[10px] font-bold py-0.5">
            Development Phase 1
          </Badge>
          <h1 className="text-3xl font-black tracking-tight">{feature}</h1>
        </div>
        
        <p className="text-muted-foreground">
          {description}
        </p>

        <div className="pt-8 flex items-center justify-center gap-4">
          <Button render={<Link href="/generate" />} variant="outline" className="h-11 rounded-xl gap-2 font-bold px-6">
            <ArrowLeft size={18} />
            Return to Engine
          </Button>
          <Button disabled className="h-11 rounded-xl font-bold px-6">
            Notify Me
          </Button>
        </div>
      </motion.div>
      
      <div className="absolute bottom-12 inset-x-0 flex flex-col items-center gap-2 opacity-20 pointer-events-none">
         <p className="text-[10px] font-black uppercase tracking-[0.3em]">QCI Engineering Center</p>
         <div className="flex gap-1">
            {[1,2,3,4,5].map(i => <div key={i} className="w-1 h-1 rounded-full bg-white" />)}
         </div>
      </div>
    </div>
  );
}
