import { defineCollection, z } from 'astro:content';

const posts = defineCollection({
    type: 'content',
    schema: z.object({
        // Minimal schema, as most data is now in the component props
        // We might use title/date if available, but they are optional
        title: z.string().optional(),
        date: z.date().optional(),
        image: z.string().optional(),
        tags: z.array(z.string()).optional(),
    }),
});

const essays = defineCollection({
    type: 'content',
    schema: z.object({
        title: z.string(),
        date: z.date(),
        description: z.string().optional(),
        draft: z.boolean().optional().default(false),
    }),
});

export const collections = {
    posts,
    essays,
};
