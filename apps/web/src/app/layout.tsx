import type { Metadata } from "next";
import { Fraunces, Geist_Mono, Public_Sans } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "QCI Central Finite Curve",
  description: "Draft, review and approve QCI documents in one place, with AI help drawn from QCI's past work.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${publicSans.variable} ${fraunces.variable} ${geistMono.variable} min-h-screen bg-surface text-text antialiased`}
      >
        <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem storageKey="cfc-theme">
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
