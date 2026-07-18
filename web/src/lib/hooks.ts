import { useEffect, useRef, useState } from 'react';
import {
  onSnapshot,
  type DocumentReference,
  type Query,
  type DocumentData,
} from 'firebase/firestore';

export interface LiveDoc<T> {
  data: T | null;
  exists: boolean | null; // null while loading
  loading: boolean;
  error: Error | null;
}

/** Realtime document subscription. Pass null to pause. */
export function useLiveDoc<T = DocumentData>(ref: DocumentReference | null): LiveDoc<T> {
  const [state, setState] = useState<LiveDoc<T>>({ data: null, exists: null, loading: !!ref, error: null });
  const path = ref?.path ?? null;
  const refBox = useRef(ref);
  refBox.current = ref;

  useEffect(() => {
    const r = refBox.current;
    if (!r) {
      setState({ data: null, exists: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const unsub = onSnapshot(
      r,
      (snap) => {
        setState({
          data: snap.exists() ? ({ ...(snap.data() as T) }) : null,
          exists: snap.exists(),
          loading: false,
          error: null,
        });
      },
      (error) => setState({ data: null, exists: null, loading: false, error }),
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return state;
}

export interface LiveRow<T> {
  id: string;
  data: T;
}

export interface LiveQuery<T> {
  rows: Array<LiveRow<T>>;
  loading: boolean;
  error: Error | null;
}

/**
 * Realtime query subscription. `key` must change when the query's constraints change
 * (Firestore Query objects aren't referentially stable across renders).
 */
export function useLiveQuery<T = DocumentData>(query: Query | null, key: string): LiveQuery<T> {
  const [state, setState] = useState<LiveQuery<T>>({ rows: [], loading: !!query, error: null });
  const queryBox = useRef(query);
  queryBox.current = query;

  useEffect(() => {
    const q = queryBox.current;
    if (!q) {
      setState({ rows: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setState({
          rows: snap.docs.map((d) => ({ id: d.id, data: d.data() as T })),
          loading: false,
          error: null,
        });
      },
      (error) => {
        console.error('live query failed', key, error);
        setState({ rows: [], loading: false, error });
      },
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
