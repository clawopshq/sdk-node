import { z } from 'zod';

export const PaginationMetaSchema = z
  .object({
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  })
  .passthrough();

export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;
