import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteDoc,
  deleteField,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import type { DraftDoc } from '@asm/shared';
import { db } from '@/lib/firebase';
import { useSession } from '@/auth/AuthProvider';

const DEBOUNCE_MS = 500;

/**
 * Local-first draft editing: keystrokes hit local state instantly, debounced writes
 * land in the draft doc (with a `base` snapshot on first touch per field for 3-way
 * conflict detection). Values equal to the remote cache auto-prune from the draft.
 */
export function useDraftEditor(
  storeId: string,
  appId: string,
  locale: string | null,
  draft: DraftDoc | null,
  cacheFor: (key: string) => string,
) {
  const { uid } = useSession();
  const [local, setLocal] = useState<Record<string, string>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const draftRef = locale ? doc(db, 'stores', storeId, 'apps', appId, 'drafts', locale) : null;

  // Reset local overlay when switching locale.
  useEffect(() => {
    setLocal({});
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, [locale, storeId, appId]);

  const remaining = (exceptKey: string): number => {
    const keys = new Set(Object.keys(draft?.fields ?? {}));
    keys.delete(exceptKey);
    return keys.size;
  };

  const flush = useCallback(
    async (key: string, value: string) => {
      if (!draftRef || !uid) return;
      const cache = cacheFor(key);
      try {
        if (value === cache) {
          // Back to the remote value → prune the field (or the whole draft doc).
          if (!draft?.fields?.[key]) return; // nothing stored
          if (remaining(key) === 0) {
            await deleteDoc(draftRef);
          } else {
            await updateDoc(draftRef, {
              [`fields.${key}`]: deleteField(),
              [`base.${key}`]: deleteField(),
              [`meta.${key}`]: deleteField(),
              status: 'open',
              updatedBy: uid,
              updatedAt: serverTimestamp(),
            });
          }
          return;
        }
        const firstTouch = draft?.base?.[key] === undefined;
        await setDoc(
          draftRef,
          {
            fields: { [key]: value },
            ...(firstTouch ? { base: { [key]: cache } } : {}),
            meta: { [key]: { by: uid, at: serverTimestamp() } },
            status: 'open',
            updatedBy: uid,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      } catch (err) {
        console.error('draft write failed', err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftRef?.path, uid, draft, cacheFor],
  );

  const set = useCallback(
    (key: string, value: string) => {
      setLocal((prev) => ({ ...prev, [key]: value }));
      const existing = timers.current.get(key);
      if (existing) clearTimeout(existing);
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          void flush(key, value);
        }, DEBOUNCE_MS),
      );
    },
    [flush],
  );

  /** Discard the draft for a field (revert to remote). */
  const revert = useCallback(
    async (key: string) => {
      setLocal((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (!draftRef || !uid || !draft?.fields || draft.fields[key] === undefined) return;
      if (remaining(key) === 0) {
        await deleteDoc(draftRef).catch(() => {});
      } else {
        await updateDoc(draftRef, {
          [`fields.${key}`]: deleteField(),
          [`base.${key}`]: deleteField(),
          [`meta.${key}`]: deleteField(),
          status: 'open',
          updatedBy: uid,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftRef?.path, uid, draft],
  );

  /** Conflict resolution: keep mine = re-base onto the new remote value. */
  const keepMine = useCallback(
    async (key: string) => {
      if (!draftRef || !uid) return;
      await updateDoc(draftRef, {
        [`base.${key}`]: cacheFor(key),
        status: 'open',
        updatedBy: uid,
        updatedAt: serverTimestamp(),
      }).catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftRef?.path, uid, cacheFor],
  );

  /** Effective value for rendering: local keystrokes > stored draft > cache. */
  const overlay = useCallback(
    (key: string, storedValue: string): string => local[key] ?? storedValue,
    [local],
  );

  return { set, revert, keepMine, overlay };
}
