import {useEffect, useRef} from "react";

/**
 * Fetches immediately when a repository is due, then uses a chained timeout
 * so slow fetches cannot overlap. Focus and repository changes recalculate
 * the remaining delay from the previous attempt.
 */
export function useAutoFetch(
  intervalMinutes: number,
  active: boolean,
  repositoryPath: string | null,
  lastFetchAttemptAt: number | null,
  fetchRemote: () => Promise<void>,
) {
  const fetchRef = useRef(fetchRemote);
  fetchRef.current = fetchRemote;

  useEffect(() => {
    if (!active || intervalMinutes <= 0) return;
    let cancelled = false;
    let timer: number | undefined;

    const schedule = (delayMs: number) => {
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        await fetchRef.current();
        if (!cancelled) schedule(intervalMinutes * 60_000);
      }, delayMs);
    };

    const intervalMs = intervalMinutes * 60_000;
    const delayMs = lastFetchAttemptAt === null
      ? 0
      : Math.max(0, lastFetchAttemptAt + intervalMs - Date.now());
    schedule(delayMs);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, intervalMinutes, lastFetchAttemptAt, repositoryPath]);
}
