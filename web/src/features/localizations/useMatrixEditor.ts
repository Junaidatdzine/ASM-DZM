import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteDoc, deleteField, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import type { DraftDoc } from '@asm/shared';
import { db } from '@/lib/firebase';
import { useSession } from '@/auth/AuthProvider';

const DEBOUNCE_MS = 600;

/**
 * Multi-locale draft writer for the "By field" matrix view: edits land in the right
 * per-locale draft doc with the same base-snapshot + auto-prune semantics as the
 * single-locale editor. Keyed by `${locale}::${fieldKey}`.
 */
export function useMatrixEditor(storeId: string, appId: string) {
  const { uid } = useSession();
  const [local, setLocal] = useState<Record<string, string>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, [storeId, appId]);

  const flush = useCallback(
    async (locale: string, key: string, value: string, cache: string) => {
      if (!uid) return;
      const ref = doc(db, 'stores', storeId, 'apps', appId, 'drafts', locale);
      try {
        const snap = await getDoc(ref);
        const draft = snap.exists() ? (snap.data() as DraftDoc) : null;
        if (value === cache) {
          if (!draft?.fields?.[key]) return;
          const others = Object.keys(draft.fields).filter((k) => k !== key);
          if (others.length === 0) {
            await deleteDoc(ref);
          } else {
            await updateDoc(ref, {
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
          ref,
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
        console.error('matrix draft write failed', err);
      }
    },
    [uid, storeId, appId],
  );

  const set = useCallback(
    (locale: string, key: string, value: string, cache: string) => {
      const id = `${locale}::${key}`;
      setLocal((prev) => ({ ...prev, [id]: value }));
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          void flush(locale, key, value, cache);
        }, DEBOUNCE_MS),
      );
    },
    [flush],
  );

  const overlay = useCallback(
    (locale: string, key: string, stored: string) => local[`${locale}::${key}`] ?? stored,
    [local],
  );

  return { set, overlay };
}
