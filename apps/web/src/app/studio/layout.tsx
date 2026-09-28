"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import qciLogo from "../../../public/qci-logo.webp";

const NAV_ITEMS = [
  { href: "/studio", label: "Studio" },
  { href: "/studio/inbox", label: "Approvals inbox" },
  { href: "/studio/templates", label: "Templates" },
  { href: "/studio/graph", label: "Knowledge graph" },
];

export default function StudioLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-surface text-text">
      <nav className="flex items-center gap-1 border-b border-border bg-surface-raised px-3 py-2 text-sm">
        <Link href="/" className="mr-2 flex items-center gap-2 rounded px-1 py-1">
          <div className="rounded bg-white px-1.5 py-1 shadow-sm">
            <Image src={qciLogo} alt="QCI" className="h-5 w-auto" />
          </div>
          <span className="hidden text-xs font-medium uppercase tracking-wider text-text-muted sm:inline">
            Central Finite Curve
          </span>
        </Link>
        {NAV_ITEMS.map((item) => {
          const active =
            item.href === "/studio" ? pathname === "/studio" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-2.5 py-1.5 font-medium transition-colors ${
                active
                  ? "bg-accent/10 text-accent"
                  : "text-text-muted hover:bg-surface-sunken hover:text-text"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
        </div>
      </nav>
      {children}
    </div>
  );
}
