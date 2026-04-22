import { LoginForm } from "@/components/login-form";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-background via-background to-primary/5">
      <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:40px_40px] pointer-events-none" />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent pointer-events-none" />
      
      <LoginForm />
      
      <div className="mt-8 text-center text-sm text-muted-foreground/60 animate-in fade-in slide-in-from-bottom-4 duration-1000 delay-500 fill-mode-both">
        <p>© 2026 Quality Council of India</p>
        <p>Project Planning and Implementation Division</p>
      </div>
    </main>
  );
}
