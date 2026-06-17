import { useCallback, useEffect, useState } from "react";
import { apply, resolve, setTheme, storedChoice, systemTheme, type Theme } from "./theme";

/**
 * The live theme + a toggle. Seeded from {@link resolve} (which the inline
 * `index.html` script already applied, so this matches the painted state).
 * While the user has made no explicit pick, follow OS changes; once they pick,
 * {@link setTheme} records it and the OS listener goes quiet.
 *
 * Single owner: the Shell holds this and feeds both the toggle and the sonner
 * Toaster, so there's one source of truth rather than divergent hook copies.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(resolve);

  // Keep the document (incl. <meta name=theme-color>) in sync. The inline
  // index.html script set data-theme pre-paint but not the meta color, so the
  // first mount reconciles it; later changes flow through here too.
  useEffect(() => {
    apply(theme);
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (storedChoice() === null) {
        const next = systemTheme();
        apply(next);
        setThemeState(next);
      }
    };
    mq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
    };
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      setTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
