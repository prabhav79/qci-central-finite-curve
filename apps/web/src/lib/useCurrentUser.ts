"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type CurrentUser, errorText, getCurrentUser } from "@/lib/cfcApi";

/** Loads /me once; a signed-out visitor is sent to /login instead of seeing
 * a raw 401. `error` is set only when the server itself can't be reached. */
export function useCurrentUser() {
  const router = useRouter();
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((u) => {
        if (cancelled) return;
        if (!u) {
          router.replace("/login");
          return;
        }
        setMe(u);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return { me, error };
}
