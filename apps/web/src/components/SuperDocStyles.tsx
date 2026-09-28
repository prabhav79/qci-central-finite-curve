"use client";

import { useEffect } from "react";

/** Load SuperDoc CSS from public/ in the browser only. */
export function SuperDocStyles() {
  useEffect(() => {
    const id = "cfc-superdoc-style";
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = "/superdoc-style.css";
      document.head.appendChild(link);
    }
    // Loaded second (and thus after) the base stylesheet above — its
    // [data-superdoc-theme] overrides depend on that source order to win
    // over :root's defaults at equal selector specificity.
    const overridesId = "cfc-superdoc-theme-overrides";
    if (!document.getElementById(overridesId)) {
      const overrides = document.createElement("link");
      overrides.id = overridesId;
      overrides.rel = "stylesheet";
      overrides.href = "/superdoc-theme-overrides.css";
      document.head.appendChild(overrides);
    }
  }, []);
  return null;
}
