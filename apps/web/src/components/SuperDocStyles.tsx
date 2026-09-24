"use client";

import { useEffect } from "react";

/** Load SuperDoc CSS from public/ in the browser only. */
export function SuperDocStyles() {
  useEffect(() => {
    const id = "cfc-superdoc-style";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "/superdoc-style.css";
    document.head.appendChild(link);
  }, []);
  return null;
}
