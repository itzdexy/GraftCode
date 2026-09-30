import { z } from 'zod';

/**
 * Every renderer → main request is declared here with a Zod schema for its
 * input and output. Main validates input before a handler runs; the renderer
 * only imports the types, so Zod is not bundled into the UI.
 */
export const ThemePreferenceSchema = z.enum(['dark', 'light', 'system']);
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;

export const ResolvedThemeSchema = z.enum(['dark', 'light']);
export type ResolvedTheme = z.infer<typeof ResolvedThemeSchema>;

export const PlatformSchema = z.enum(['win32', 'darwin', 'linux']);
export type Platform = z.infer<typeof PlatformSchema>;

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: PlatformSchema,
  isPackaged: z.boolean(),
  versions: z.object({ electron: z.string(), chrome: z.string(), node: z.string() })
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

const channel = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({ input, output });

export const contracts = {
  'app:info': channel(z.void(), AppInfoSchema),
  'window:setTitlebarTheme': channel(z.object({ theme: ResolvedThemeSchema }), z.void())
};

export type Contracts = typeof contracts;
export type Channel = keyof Contracts;
export type ChannelInput<C extends Channel> = z.input<Contracts[C]['input']>;
export type ChannelParsedInput<C extends Channel> = z.output<Contracts[C]['input']>;
export type ChannelOutput<C extends Channel> = z.output<Contracts[C]['output']>;
