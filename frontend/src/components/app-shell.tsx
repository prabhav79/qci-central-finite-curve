"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { clearToken, getSubject } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  FileText,
  Search,
  Upload,
  LogOut,
  ChevronRight,
  Menu,
  Shield,
  LayoutDashboard,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";

const NAV_ITEMS = [
  { label: "Generate", href: "/generate", icon: FileText },
  { label: "Search", href: "/search", icon: Search },
  { label: "Ingest", href: "/ingest", icon: Upload },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [subject, setSubject] = useState<string | null>(null);

  useEffect(() => {
    setSubject(getSubject());
  }, []);

  const handleLogout = () => {
    clearToken();
    router.push("/");
  };

  const NavContent = () => (
    <div className="flex flex-col h-full">
      <div className="p-6">
        <Link href="/generate" className="flex items-center gap-2 group">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground group-hover:scale-110 transition-transform">
            <LayoutDashboard size={20} />
          </div>
          <span className="font-bold text-lg tracking-tight text-foreground uppercase">
            QCI <span className="text-primary font-black">CFC</span>
          </span>
        </Link>
      </div>

      <nav className="flex-1 px-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group",
                isActive
                  ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}
            >
              <item.icon
                size={22}
                className={cn(isActive ? "text-inherit" : "group-hover:scale-110 transition-transform")}
              />
              <span className="font-medium">{item.label}</span>
              {isActive && (
                <ChevronRight size={16} className="ml-auto opacity-70" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 mt-auto">
        <div className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary">
              <Shield size={20} />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                Active Session
              </p>
              <p className="text-sm font-semibold truncate leading-tight">
                {subject || "Demo User"}
              </p>
            </div>
          </div>
          <Separator className="bg-white/10" />
          <Button
            variant="ghost"
            className="w-full justify-start text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            onClick={handleLogout}
          >
            <LogOut size={18} className="mr-2" />
            Sign Out
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex flex-col w-72 border-r border-white/5 bg-card/50 backdrop-blur-xl">
        <NavContent />
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="lg:hidden flex items-center justify-between p-4 border-b border-white/5 bg-card/50 backdrop-blur-xl">
          <Link href="/generate" className="font-bold tracking-tight text-foreground uppercase">
            QCI <span className="text-primary font-black">CFC</span>
          </Link>
          
          <Sheet>
            <SheetTrigger render={<Button variant="ghost" size="icon" />}>
              <Menu />
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-72 bg-card border-r-white/5">
              <NavContent />
            </SheetContent>
          </Sheet>
        </header>

        <main className="flex-1 overflow-y-auto bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-primary/5 via-transparent to-transparent">
          {children}
        </main>
      </div>
    </div>
  );
}
