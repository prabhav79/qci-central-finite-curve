import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "QCI Central Finite Curve",
  description: "Institutional knowledge platform for QCI's PPID division",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} dark h-full antialiased`}>
      <body className={`${inter.className} min-h-full flex flex-col`}>
        <TooltipProvider>
          {children}
          <Toaster position="top-right" expand={false} richColors />
        </TooltipProvider>
      </body>
    </html>
  );
}
