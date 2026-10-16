import { z } from 'zod';

/**
 * What a site is built with. "react-ts": a React and TypeScript project that is built into its dist
 * folder. "plain": HTML, CSS and JavaScript files served as they are.
 */
export const SITE_STACKS = ['react-ts', 'plain'] as const;
export const SiteStackSchema = z.enum(SITE_STACKS);
export type SiteStack = z.infer<typeof SiteStackSchema>;

/** A website from the Sites tab, as the gallery shows it. */
export const SiteViewSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  /** Where Graft serves it on this computer: http://<slug>.localhost:<port>/. */
  url: z.string(),
  folder: z.string(),
  updatedAt: z.number(),
  sessionId: z.string().nullable(),
  stack: SiteStackSchema,
  /** A picture of the page as a data URL, once one was taken. */
  thumbnail: z.string().nullable()
});
export type SiteView = z.infer<typeof SiteViewSchema>;
