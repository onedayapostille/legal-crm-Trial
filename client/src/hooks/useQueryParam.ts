import { useCallback } from "react";
import { useLocation, useSearch } from "wouter";

/**
 * Syncs a single string value to a URL query parameter (using wouter), giving a
 * `useState`-like API. Because the value lives in the URL, it survives
 * List → Detail → Back navigation: pressing the browser Back button returns to
 * the list URL with its filters/search intact.
 *
 *   const [search, setSearch] = useQueryParam("search", "");
 *   const [status, setStatus] = useQueryParam("status", "all");
 *
 * Writes use history *replace* so editing a filter updates the current history
 * entry in place (no extra Back steps), while still being restored on Back.
 * When the value equals the default it is removed from the URL to keep it clean.
 */
export function useQueryParam(
  key: string,
  defaultValue = "",
): [string, (value: string) => void] {
  const [path, navigate] = useLocation();
  const search = useSearch();
  const value = new URLSearchParams(search).get(key) ?? defaultValue;

  const setValue = useCallback(
    (next: string) => {
      // Read the live query string so multiple setters called in sequence within
      // one handler merge instead of clobbering each other.
      const params = new URLSearchParams(window.location.search);
      if (!next || next === defaultValue) params.delete(key);
      else params.set(key, next);
      const qs = params.toString();
      navigate(path + (qs ? `?${qs}` : ""), { replace: true });
    },
    [key, defaultValue, path, navigate],
  );

  return [value, setValue];
}
