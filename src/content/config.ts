import { defineCollection, z } from 'astro:content';

const posts = defineCollection({
    type: 'content',
    schema: z.object({
        title: z.string().optional(),
        date: z.date(),
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
    }),
});

export const collections = {
    posts,
    essays,
};
