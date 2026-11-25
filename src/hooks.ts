import { useCallback, useEffect, useRef, useState } from "react";

/** Asynchronous loader hook: returns data, loading state, error, and reload trigger. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const seqRef = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async () => {
    const seq = ++seqRef.current;
    if (alive.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fnRef.current();
      if (alive.current && seq === seqRef.current) setData(res);
    } catch (e) {
      if (alive.current && seq === seqRef.current) setError((e as Error).message || "Failed to load");
    } finally {
      if (alive.current && seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    run();
    return () => {
      alive.current = false;
      seqRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, reload: run, setData };
}

/** Paginated list: automatically fetches next page on reaching bottom. */
export function usePaged<T>(fetcher: (page: number) => Promise<{ items: T[]; pagination?: { pages: number } }>, deps: unknown[] = []) {
  const [items, setItems] = useState<T[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetEpoch, setResetEpoch] = useState(0);
  const busy = useRef(false);
  const seqRef = useRef(0);
  const didMountRef = useRef(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const loadMore = useCallback(async () => {
    if (busy.current || page >= pages) return;
    const seq = ++seqRef.current;
    busy.current = true;
    setLoading(true);
    try {
      const next = page + 1;
      const res = await fetcherRef.current(next);
      if (seq !== seqRef.current) return;
      setItems((prev) => {
        const seen = new Set(
          prev
            .map((x) => (x as { id?: unknown }).id)
            .filter((id): id is string | number => typeof id === "number" || typeof id === "string")
        );
        return [
          ...prev,
          ...(res.items || []).filter((x) => {
            const id = (x as { id?: unknown }).id;
            if (typeof id !== "number" && typeof id !== "string") return true;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          }),
        ];
      });
      setPage(next);
      setPages(res.pagination?.pages || next);
      setError(null);
    } catch (e) {
      if (seq === seqRef.current) {
        setError((e as Error).message || "Failed to load");
      }
    } finally {
      if (seq === seqRef.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [page, pages]);

  const reset = useCallback(() => {
    seqRef.current++;
    busy.current = false;
    setLoading(false);
    setItems([]);
    setPage(0);
    setPages(1);
    setError(null);
    setResetEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    return () => {
      seqRef.current++;
      busy.current = false;
    };
  }, []);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (page === 0) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, resetEpoch]);

  return { items, loading, error, loadMore, hasMore: page < pages, reset };
}