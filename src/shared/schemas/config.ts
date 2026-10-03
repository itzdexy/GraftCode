import { z } from 'zod';
import { PermissionModeSchema } from './common';

/**
 * Shape of Graft settings files:
 *   user    ~/.graft/settings.json
 *   project <project>/.graft/settings.json        (shared, committed)
 *   local   <project>/.graft/settings.local.json  (per machine, ignored)
 * Project and local hooks/MCP servers apply only to trusted projects.
 */
export const SETTINGS_SCOPES = ['user', 'project', 'local'] as const;
export const SettingsScopeSchema = z.enum(SETTINGS_SCOPES);
export type SettingsScope = z.infer<typeof SettingsScopeSchema>;

export const RuleListSchema = z.array(z.string().min(1).max(1000)).max(500);

export const PermissionRulesSchema = z.object({
  allow: RuleListSchema.default([]),
  ask: RuleListSchema.default([]),
  deny: RuleListSchema.default([]),
  defaultMode: PermissionModeSchema.optional()
});
export type PermissionRules = z.infer<typeof PermissionRulesSchema>;

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as const;
export const HookEventSchema = z.enum(HOOK_EVENTS);
export type HookEvent = z.infer<typeof HookEventSchema>;

export const HookCommandSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1).max(4000),
  /** Seconds; defaults to 60. */
  timeout: z.number().int().min(1).max(600).optional()
});
export type HookCommand = z.infer<typeof HookCommandSchema>;

export const HookMatcherSchema = z.object({
  /** Tool-name pattern for tool events (e.g. "Shell", "Edit|Write", "*"); ignored otherwise. */
  matcher: z.string().max(200).optional(),
  hooks: z.array(HookCommandSchema).min(1).max(20)
});
export type HookMatcher = z.infer<typeof HookMatcherSchema>;

export const HooksConfigSchema = z.partialRecord(HookEventSchema, z.array(HookMatcherSchema).max(50));
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

export const McpServerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, "-" or "_"');

export const McpServerConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1).max(2000),
    args: z.array(z.string().max(4000)).max(100).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    enabled: z.boolean().default(true)
  }),
  z.object({
    type: z.literal('http'),
    url: z.url({ protocol: /^https?$/ }),
    headers: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true)
  })
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * A project's checks: commands Graft runs after a turn changes files, such
 * as a type check, a linter or the tests. A failure goes back to the agent
 * to fix when `fix` is on.
 */
export const ChecksConfigSchema = z.object({
  commands: z.array(z.string().trim().min(1).max(2000)).min(1).max(10),
  fix: z.boolean().default(true),
  /** Per command. The ceiling is the shell runner's own limit; a check that needs longer belongs in a background job. */
  timeoutSec: z.number().int().min(10).max(600).default(300)
});
export type ChecksConfig = z.infer<typeof ChecksConfigSchema>;

export const SettingsFileSchema = z.looseObject({
  permissions: PermissionRulesSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  mcpServers: z.record(McpServerNameSchema, McpServerConfigSchema).optional(),
  checks: ChecksConfigSchema.optional()
});
export type SettingsFile = z.infer<typeof SettingsFileSchema>;
