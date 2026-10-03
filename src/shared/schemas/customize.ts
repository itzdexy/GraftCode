import { z } from 'zod';
import { ChecksConfigSchema, HooksConfigSchema, McpServerNameSchema, SettingsScopeSchema } from './config';

/** Customize screen: commands, skills, memory files, hooks and MCP servers. */

export const CustomScopeSchema = z.enum(['user', 'project']);
export type CustomScopeView = z.infer<typeof CustomScopeSchema>;

export const CommandFileSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().nullable(),
  scope: CustomScopeSchema,
  path: z.string(),
  body: z.string()
});
export type CommandFileView = z.infer<typeof CommandFileSchema>;

/** A custom sub-agent: tools null means it gets the general sub-agent's tools. */
export const AgentFileSchema = z.object({
  name: z.string(),
  description: z.string(),
  tools: z.array(z.string()).nullable(),
  scope: CustomScopeSchema,
  path: z.string(),
  body: z.string()
});
export type AgentFileView = z.infer<typeof AgentFileSchema>;

export const SkillFileSchema = z.object({
  name: z.string(),
  description: z.string(),
  scope: CustomScopeSchema,
  path: z.string(),
  body: z.string()
});
export type SkillFileView = z.infer<typeof SkillFileSchema>;

export const MemoryInfoSchema = z.object({
  scope: CustomScopeSchema,
  path: z.string(),
  exists: z.boolean(),
  content: z.string(),
  fallback: z.string().nullable()
});
export type MemoryInfoView = z.infer<typeof MemoryInfoSchema>;

export const ScopedHooksSchema = z.object({
  scope: SettingsScopeSchema,
  path: z.string(),
  error: z.string().nullable(),
  hooks: HooksConfigSchema
});
export type ScopedHooksView = z.infer<typeof ScopedHooksSchema>;

/** Where a project's checks can be saved: shared with the repository, or this computer only (wins). */
export const ChecksScopeSchema = z.enum(['project', 'local']);
export type ChecksScope = z.infer<typeof ChecksScopeSchema>;

export const ChecksViewSchema = z.object({
  files: z.array(z.object({ scope: ChecksScopeSchema, path: z.string(), error: z.string().nullable(), checks: ChecksConfigSchema.nullable() })),
  /** Commands that look right for this project (its scripts, manifest and lockfile). */
  suggestions: z.array(z.string()),
  trusted: z.boolean()
});
export type ChecksView = z.infer<typeof ChecksViewSchema>;

export const McpStateSchema = z.enum(['connecting', 'connected', 'failed', 'disabled', 'needs-auth', 'idle', 'untrusted']);
export type McpStateView = z.infer<typeof McpStateSchema>;

/** Server config as shown in the UI: environment and header values never leave main. */
export const McpConfigViewSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), command: z.string(), args: z.array(z.string()), envKeys: z.array(z.string()), cwd: z.string().nullable(), enabled: z.boolean() }),
  z.object({ type: z.literal('http'), url: z.string(), headerKeys: z.array(z.string()), enabled: z.boolean() })
]);

export const McpServerViewSchema = z.object({
  name: z.string(),
  scope: SettingsScopeSchema,
  path: z.string(),
  config: McpConfigViewSchema,
  state: McpStateSchema,
  error: z.string().nullable(),
  tools: z.array(z.object({ name: z.string(), description: z.string(), readOnly: z.boolean() }))
});
export type McpServerView = z.infer<typeof McpServerViewSchema>;

const SecretMap = z.record(z.string().min(1).max(200), z.string().max(8000));

/** Saving a server: new secret values, plus names of existing ones to keep unchanged. */
export const McpServerInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1).max(2000),
    args: z.array(z.string().max(4000)).max(100),
    env: SecretMap,
    keepEnv: z.array(z.string().max(200)).max(200),
    cwd: z.string().max(4096).nullable(),
    enabled: z.boolean()
  }),
  z.object({
    type: z.literal('http'),
    url: z.url({ protocol: /^https?$/ }),
    headers: SecretMap,
    keepHeaders: z.array(z.string().max(200)).max(200),
    enabled: z.boolean()
  })
]);
export type McpServerInput = z.infer<typeof McpServerInputSchema>;

export { McpServerNameSchema };
