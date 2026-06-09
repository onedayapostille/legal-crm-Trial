import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation } from "wouter";

/**
 * Window scroll restoration for the SPA.
 *
 * Native browser scroll restoration is unreliable for client-rendered routes
 * whose content loads asynchronously (the page is short when the browser tries
 * to restore, so the position is clamped). This component takes over:
 *
 *  - Disables native restoration (`history.scrollRestoration = "manual"`).
 *  - Continuously remembers the scroll position for the current pathname.
 *  - On navigation, restores the remembered position for the target pathname
 *    (retrying across frames while async data grows the page), or scrolls to the
 *    top for a first visit.
 *
 * Keyed by pathname (not the query string) so changing a filter on a list does
 * NOT jump the scroll, while List → Detail → Back restores it.
 */
export default function ScrollRestoration() {
  const [path] = useLocation();
  const positions = useRef<Map<string, number>>(new Map());
  const currentPath = useRef(path);

  // Track scroll for the active pathname.
  useEffect(() => {
    if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    const onScroll = () => {
      positions.current.set(currentPath.current, window.scrollY);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // On pathname change, restore the saved position (or go to top).
  useLayoutEffect(() => {
    if (currentPath.current === path) return;
    currentPath.current = path;

    const target = positions.current.get(path) ?? 0;
    let frames = 0;
    const apply = () => {
      window.scrollTo(0, target);
      // Keep trying while async content is still shorter than the target,
      // up to ~0.6s, then give up gracefully.
      if (window.scrollY !== target && frames++ < 40) {
        requestAnimationFrame(apply);
      }
    };
    apply();
  }, [path]);

  return null;
}
