// Schemas more than one kind reads, declared once so each is the same schema wherever it is used.
// Server only: the web build carries no zod (the kinds' server.ts files, which use these, are left out).

import { z } from 'zod';

// Free text: a note's text, and a code block's.
export const plainText = z.string().optional();

// What a code block or a chart highlights, as agents send it: lines, or a category.
export const highlightType = z.union([z.string(), z.array(z.union([z.number().int(), z.array(z.number().int())]))]).optional();
