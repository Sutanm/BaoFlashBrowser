import { z } from 'zod';

const length = z.string().regex(/^\d+$/);
export const aria2GidSchema = z.string().regex(/^[0-9a-f]{16}$/i);
export const aria2StatusSchema = z.object({
  totalLength: length,
  completedLength: length,
  downloadSpeed: length,
  status: z.enum(['active', 'waiting', 'paused', 'error', 'complete', 'removed']),
  files: z.array(z.object({ path: z.string() })).optional(),
});
