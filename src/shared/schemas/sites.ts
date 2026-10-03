import { z } from 'zod';

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
  /** A picture of the page as a data URL, once one was taken. */
  thumbnail: z.string().nullable()
});
export type SiteView = z.infer<typeof SiteViewSchema>;
