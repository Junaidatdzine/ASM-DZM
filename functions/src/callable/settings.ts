import { z } from 'zod';
import { AI_MODELS } from '@asm/shared';
import { defineCallable } from '../lib/wrap';
import { refs } from '../lib/firestore';
import { requireAdmin } from '../lib/authz';

const modelIds = AI_MODELS.map((m) => m.id) as [string, ...string[]];

export const settingsUpdate = defineCallable(
  'settingsUpdate',
  {
    input: z.object({
      aiModel: z.enum(modelIds).optional(),
      idleTimeoutMinutes: z.number().int().min(5).max(44640).nullable().optional(),
      allowedDomains: z
        .array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a bare domain like acme.com'))
        .max(50)
        .optional(),
      reportEmails: z.array(z.string().trim().toLowerCase().email()).max(20).optional(),
      reportHour: z.number().int().min(0).max(23).optional(),
    }),
    authorize: (actor) => requireAdmin(actor),
    audit: (input) => ({
      action: 'settings.update',
      detail: Object.keys(input).join(', '),
    }),
  },
  async (input) => {
    const patch: Record<string, unknown> = {};
    if (input.aiModel !== undefined) patch.aiModel = input.aiModel;
    if (input.idleTimeoutMinutes !== undefined) patch.idleTimeoutMinutes = input.idleTimeoutMinutes;
    if (input.allowedDomains !== undefined) {
      patch.allowedDomains = [...new Set(input.allowedDomains)];
    }
    if (input.reportEmails !== undefined) patch.reportEmails = [...new Set(input.reportEmails)];
    if (input.reportHour !== undefined) patch.reportHour = input.reportHour;
    await refs.settings().set(patch, { merge: true });
    return { ok: true };
  },
);
