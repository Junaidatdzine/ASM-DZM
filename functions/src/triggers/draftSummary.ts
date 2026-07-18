import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import type { DraftDoc } from '@asm/shared';
import { REGION } from '../config';
import { Timestamp, refs } from '../lib/firestore';

/** Keep app cards fast and accurate without client-side aggregate bookkeeping. */
export const appDraftSummary = onDocumentWritten(
  { document: 'stores/{storeId}/apps/{appId}/drafts/{locale}', region: REGION },
  async (event) => {
    const { storeId, appId } = event.params;
    const snap = await refs.app(storeId, appId).collection('drafts').get();
    let pendingDraftFields = 0;
    let latest: DraftDoc | null = null;
    for (const doc of snap.docs) {
      const draft = doc.data() as DraftDoc;
      pendingDraftFields += Object.keys(draft.fields ?? {}).length;
      if (!latest || draft.updatedAt?.toMillis() > latest.updatedAt?.toMillis()) latest = draft;
    }
    const now = Timestamp.now();
    await refs.app(storeId, appId).set({
      pendingDraftFields,
      lastActivityAt: now,
      ...(latest ? { lastEditedAt: latest.updatedAt, lastEditedBy: latest.updatedBy } : {}),
    }, { merge: true });
  },
);
