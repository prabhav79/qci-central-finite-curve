"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid a hydration mismatch: resolvedTheme is unknown on the server.
  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to Paper theme" : "Switch to Night theme"}
      className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
    >
      {mounted && (
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2">
          {isDark ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
            />
          ) : (
            <>
              <circle cx="12" cy="12" r="4" />
              <path
                strokeLinecap="round"
                d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"
              />
            </>
          )}
        </svg>
      )}
    </button>
  );
}
