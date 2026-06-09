import { useCallback } from "react";
import { useLocation } from "wouter";

/**
 * Returns a "go back" handler for detail pages. It uses the browser History API
 * so Back returns to the exact previous entry — restoring the list URL with its
 * filters, search, and (via ScrollRestoration) scroll position. Falls back to a
 * known route when there is no in-app history to go back to (e.g. deep link).
 */
export function useGoBack(fallback: string): () => void {
  const [, navigate] = useLocation();
  return useCallback(() => {
    // history.length > 1 means there is a previous entry to return to.
    if (typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
    } else {
      navigate(fallback);
    }
  }, [navigate, fallback]);
}
