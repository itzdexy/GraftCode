import { z } from 'zod';

export const CatalogSyncStatusSchema = z.object({
  source: z.literal('https://models.dev/api.json'),
  state: z.enum(['bundled', 'cached', 'refreshing', 'current', 'error']),
  verifiedAt: z.number().int().nullable(), fetchedAt: z.number().int().nullable(),
  error: z.string().nullable(),
  changes: z.object({ added: z.number().int(), changed: z.number().int(), omitted: z.number().int(), deprecated: z.number().int() })
});
export type CatalogSyncStatus = z.infer<typeof CatalogSyncStatusSchema>;
