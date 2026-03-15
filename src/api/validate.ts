import { z } from 'zod';

export function validate<S extends z.ZodTypeAny>(schema: S, data: unknown): { data: z.infer<S> } | { error: string } {
    const result = schema.safeParse(data);
    if (!result.success) {
        return { error: result.error.issues.map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }
    return { data: result.data as z.infer<S> };
}
