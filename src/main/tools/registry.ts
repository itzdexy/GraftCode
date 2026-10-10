import { z } from 'zod';
import type { ToolSpec } from '../providers/types';
import type { AnyTool, ToolDefinition } from './types';

/** Converts a Zod input schema to the JSON Schema offered to models. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register<I>(tool: ToolDefinition<I>): void {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    if (this.tools.has(tool.name)) throw new Error(`Tool registered twice: ${tool.name}`);
    this.tools.set(tool.name, tool as unknown as AnyTool);
  }

  /** Registers or replaces a dynamic tool (MCP). */
  upsert<I>(tool: ToolDefinition<I>): void {
    this.tools.set(tool.name, tool as unknown as AnyTool);
  }

  remove(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  list(filter?: (tool: AnyTool) => boolean): AnyTool[] {
    const all = [...this.tools.values()];
    return filter ? all.filter(filter) : all;
  }

  /**
   * Tool specs in a stable (name-sorted) order so provider prompt caches stay warm.
   * `descriptions` says what a tool is where it is offered, when that differs from its own words.
   */
  specs(names?: string[], descriptions: Partial<Record<string, string>> = {}): ToolSpec[] {
    const selected = names ? names.map((n) => this.tools.get(n)).filter((t): t is AnyTool => t !== undefined) : this.list();
    return selected
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: descriptions[t.name] ?? t.description, inputSchema: t.jsonSchema ?? jsonSchemaFor(t.input as z.ZodType) }));
  }
}
