import Image from "next/image";
import qciLogo from "../../public/qci-logo.webp";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-surface p-8 text-text">
      <div className="animate-rise-in inline-block rounded-lg bg-white px-4 py-3 shadow-sm">
        <Image src={qciLogo} alt="Quality Council of India" className="h-9 w-auto" />
      </div>
      <div className="w-full max-w-sm animate-rise-in [animation-delay:80ms]">{children}</div>
    </main>
  );
}
