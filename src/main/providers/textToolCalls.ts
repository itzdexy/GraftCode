import { ProviderError } from './errors';
import type { ToolSpec } from './types';

/**
 * Tool calls a model wrote as text. Many local servers hand a model's tool calls back as
 * plain text instead of native tool calls, in one of a few formats: Hermes-style
 * `<tool_call>` JSON, Qwen3-Coder's `<function=…>` XML, or Mistral's `[TOOL_CALLS]` list.
 * This module reads those formats, keeps them out of the visible text while it streams, and
 * writes the prompt and transcript markup that teaches a model to use them.
 */
export interface TextToolCall {
  name: string;
  input: Record<string, unknown>;
}

const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';
const FUNCTION_OPEN = '<function=';
const FUNCTION_CLOSE = '</function>';
const MISTRAL_OPEN = '[TOOL_CALLS]';

/** The offered tools, by name, each with its `inputSchema`. A name not in the map is unknown. */
type ToolSchemas = ReadonlyMap<string, Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * A call from a parsed `{"name": …, "arguments": …}` object, or null when it names a tool
 * that isn't offered or its arguments aren't an object. Arguments may come as `parameters`
 * and may be a JSON string, as some chat templates encode them. Inside explicit markup a call
 * may leave its arguments out; a whole reply of bare JSON must carry them to count as a call.
 */
function callFrom(value: unknown, tools: ToolSchemas, requireArguments: boolean): TextToolCall | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !tools.has(value.name)) return null;
  const raw = value.arguments ?? value.parameters;
  if (raw === undefined) return requireArguments ? null : { name: value.name, input: {} };
  const args = typeof raw === 'string' ? (raw.trim() === '' ? {} : parseJson(raw)) : raw;
  return isRecord(args) ? { name: value.name, input: args } : null;
}

/** Whether the schema declares this property a string, alone or as one of several types. */
function isStringProperty(schema: Record<string, unknown>, key: string): boolean {
  const properties = schema.properties;
  const property = isRecord(properties) ? properties[key] : undefined;
  const type = isRecord(property) ? property.type : undefined;
  return type === 'string' || (Array.isArray(type) && type.includes('string'));
}

/**
 * A Qwen3-Coder `<function=N>` element's name and body, read as a call. The XML form carries
 * no types, so a value the schema calls a string stays the text the model wrote: a file's
 * content of `{"a":1}` or `42` must not turn into an object or a number. Other values are
 * read as JSON when they parse, so numbers and booleans arrive typed.
 */
function functionCall(name: string, body: string, tools: ToolSchemas): TextToolCall | null {
  const trimmedName = name.trim();
  const schema = tools.get(trimmedName);
  if (!schema) return null;
  const input: Record<string, unknown> = {};
  const parameter = /<parameter=([^>\n]+)>([\s\S]*?)<\/parameter>/g;
  const rest = body.replace(parameter, (_whole, rawKey: string, value: string) => {
    const key = rawKey.trim();
    const text = value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const parsed = isStringProperty(schema, key) ? undefined : parseJson(value);
    input[key] = parsed !== undefined ? parsed : text;
    return '';
  });
  // Anything but whitespace between the parameters means this isn't a well-formed call.
  return rest.trim() === '' ? { name: trimmedName, input } : null;
}

/** A `<function=N>…</function>` element that is the whole of `text`, read as a call. */
function functionElement(text: string, tools: ToolSchemas): TextToolCall | null {
  const match = /^<function=([^>\n]+)>([\s\S]*)<\/function>$/.exec(text.trim());
  return match ? functionCall(match[1] ?? '', match[2] ?? '', tools) : null;
}

/**
 * The end (exclusive) of the JSON array or object that starts at `start`, found by matching
 * brackets outside strings, or -1 when it never closes.
 */
function jsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

interface Span {
  start: number;
  end: number;
  calls: TextToolCall[];
}

/** The markup at `start` (which begins with one of the openers), read as calls, or null. */
function readMarkup(text: string, start: number, tools: ToolSchemas): Span | null {
  if (text.startsWith(TOOL_CALL_OPEN, start)) {
    const bodyStart = start + TOOL_CALL_OPEN.length;
    const close = text.indexOf(TOOL_CALL_CLOSE, bodyStart);
    if (close === -1) return null;
    const body = text.slice(bodyStart, close);
    // A later opener before the close means this one was prose ("use <tool_call> tags").
    if (body.includes(TOOL_CALL_OPEN)) return null;
    const call = body.trim().startsWith(FUNCTION_OPEN)
      ? functionElement(body, tools)
      : callFrom(parseJson(body), tools, false);
    return call ? { start, end: close + TOOL_CALL_CLOSE.length, calls: [call] } : null;
  }
  if (text.startsWith(FUNCTION_OPEN, start)) {
    const close = text.indexOf(FUNCTION_CLOSE, start);
    if (close === -1) return null;
    const end = close + FUNCTION_CLOSE.length;
    const call = functionElement(text.slice(start, end), tools);
    return call ? { start, end, calls: [call] } : null;
  }
  // Mistral: `[TOOL_CALLS]` followed by a JSON list of calls.
  let listStart = start + MISTRAL_OPEN.length;
  while (/\s/.test(text[listStart] ?? '')) listStart++;
  if (text[listStart] !== '[') return null;
  const end = jsonEnd(text, listStart);
  if (end === -1) return null;
  const list = parseJson(text.slice(listStart, end));
  if (!Array.isArray(list) || list.length === 0) return null;
  const calls = list.map((item) => callFrom(item, tools, false));
  // The list is one piece of markup, so it is read whole or left whole: removing only the
  // known calls would leave a rewritten list the model never wrote.
  if (calls.some((call) => call === null)) return null;
  return { start, end, calls: calls as TextToolCall[] };
}

/**
 * Splits text into runs inside and outside ``` fences. A fence opens on a line that starts
 * with three or more backticks and closes on the next such line; an unclosed fence runs to the
 * end, since a model that is still showing code hasn't written a call.
 */
function fenceRuns(text: string): { text: string; fenced: boolean }[] {
  const runs: { text: string; fenced: boolean }[] = [];
  let current = '';
  let fenced = false;
  for (const line of text.split(/(?<=\n)/)) {
    if (/^[ \t]*```/.test(line)) {
      if (fenced) {
        runs.push({ text: current + line, fenced: true });
        current = '';
      } else {
        runs.push({ text: current, fenced: false });
        current = line;
      }
      fenced = !fenced;
    } else {
      current += line;
    }
  }
  runs.push({ text: current, fenced });
  return runs;
}

/**
 * The end of the inline code span that holds `index`, or -1 when it is in none. A span opens
 * with a run of backticks and closes at the next run of the same length on the same line, as in
 * Markdown; a run with no match on its line is a literal backtick. Only the line from `from`
 * on is read, so backticks inside markup already read as a call don't pair with later ones.
 */
function codeSpanEnd(text: string, from: number, index: number): number {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const newline = text.indexOf('\n', index);
  const lineEnd = newline === -1 ? text.length : newline;
  const runs = /`+/g;
  runs.lastIndex = Math.max(from, lineStart);
  for (let open = runs.exec(text); open && open.index < index; open = runs.exec(text)) {
    const closer = new RegExp(`(?<!\`)\`{${open[0].length}}(?!\`)`, 'g');
    closer.lastIndex = open.index + open[0].length;
    const close = closer.exec(text);
    if (!close || close.index >= lineEnd) continue;
    if (close.index > index) return close.index + close[0].length;
    runs.lastIndex = close.index + close[0].length;
  }
  return -1;
}

/**
 * A reply that is nothing but `{"name": …, "arguments": …}`, bare or in one json fence. Some
 * models answer a tools prompt this way. It only counts when the whole reply is that object.
 */
function wholeReplyCall(text: string, tools: ToolSchemas): TextToolCall | null {
  const trimmed = text.trim();
  const fence = /^```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```$/i.exec(trimmed);
  const body = (fence ? (fence[1] ?? '') : trimmed).trim();
  if (!body.startsWith('{')) return null;
  return callFrom(parseJson(body), tools, true);
}

const OPENERS = [TOOL_CALL_OPEN, FUNCTION_OPEN, MISTRAL_OPEN];

/**
 * Reads the tool calls a model wrote as text, in the order it wrote them, and returns the text
 * with that markup removed and trimmed. Markup inside a ``` fence or an inline code span is an
 * example, not a call.
 * A call to a tool that isn't in `tools`, or one whose JSON doesn't parse, stays in the text
 * so the user sees what the model wrote. When nothing is read, the text comes back unchanged.
 */
export function extractTextToolCalls(
  text: string,
  tools: ToolSchemas,
): { text: string; calls: TextToolCall[] } {
  const whole = wholeReplyCall(text, tools);
  if (whole) return { text: '', calls: [whole] };

  const calls: TextToolCall[] = [];
  let out = '';
  for (const run of fenceRuns(text)) {
    if (run.fenced) {
      out += run.text;
      continue;
    }
    let position = 0;
    for (;;) {
      const starts = OPENERS.map((opener) => run.text.indexOf(opener, position)).filter((index) => index !== -1);
      if (starts.length === 0) break;
      const start = Math.min(...starts);
      // Markup quoted in inline code is the model showing the format, not using it.
      const quoted = codeSpanEnd(run.text, position, start);
      if (quoted !== -1) {
        out += run.text.slice(position, quoted);
        position = quoted;
        continue;
      }
      const span = readMarkup(run.text, start, tools);
      if (span) {
        out += run.text.slice(position, span.start);
        calls.push(...span.calls);
        position = span.end;
      } else {
        // Not a call: keep the opener as text and look for the next one after it.
        out += run.text.slice(position, start + 1);
        position = start + 1;
      }
    }
    out += run.text.slice(position);
  }
  return calls.length === 0 ? { text, calls } : { text: out.trim(), calls };
}

const MARKERS = ['<tool_call', FUNCTION_OPEN, MISTRAL_OPEN];

/**
 * Decides what streamed text is safe to show before the reply is complete. It holds back
 * everything from the first tool-call marker, and any chunk end that could be the start of
 * one, so markup never flashes on screen. It never reads calls: once the reply is complete the
 * adapter runs `extractTextToolCalls` on the full text, and `flush` hands back what was held.
 */
export class ToolMarkupFilter {
  private held = '';
  private holding = false;

  push(delta: string): string {
    if (this.holding) {
      this.held += delta;
      return '';
    }
    const text = this.held + delta;
    const starts = MARKERS.map((marker) => text.indexOf(marker)).filter((index) => index !== -1);
    if (starts.length > 0) {
      const start = Math.min(...starts);
      this.held = text.slice(start);
      this.holding = true;
      return text.slice(0, start);
    }
    const keep = partialMarkerLength(text);
    this.held = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }

  flush(): string {
    const held = this.held;
    this.held = '';
    this.holding = false;
    return held;
  }
}

/** The length of the longest end of `text` that is the start of a marker. */
function partialMarkerLength(text: string): number {
  let longest = 0;
  for (const marker of MARKERS) {
    for (let length = Math.min(marker.length - 1, text.length); length > longest; length--) {
      if (text.endsWith(marker.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

const PROMPT_HEADER = `# Calling tools
You have tools. To use one, write a tool call in exactly this form:
<tool_call>
{"name": "Read", "arguments": {"file_path": "src/index.ts"}}
</tool_call>
You can write several tool calls in one reply. After them, stop: the results come back in the next message inside <tool_response> tags. Use only the tools listed below, with arguments that match their schema.

## Tools`;

/** The system prompt section that teaches a model without native tool calls to write them as text. */
export function textToolPrompt(tools: ToolSpec[]): string {
  const sections = tools.map(
    (tool) => `### ${tool.name}\n${tool.description}\nArguments (JSON Schema): ${JSON.stringify(tool.inputSchema)}`,
  );
  return [PROMPT_HEADER, ...sections].join('\n\n');
}

/** An earlier call written back into the transcript in the form the prompt teaches. */
export function toolCallMarkup(name: string, input: unknown): string {
  return `${TOOL_CALL_OPEN}\n${JSON.stringify({ name, arguments: input ?? {} })}\n${TOOL_CALL_CLOSE}`;
}

/** A tool's result written into the transcript for a model that reads calls as text. */
export function toolResponseMarkup(name: string, text: string, isError: boolean): string {
  return `<tool_response name="${name}">\n${isError ? 'Error: ' : ''}${text}\n</tool_response>`;
}

/**
 * Whether a server refused a request because the model has no native tool calls. Ollama and
 * the OpenAI-compatible servers word it differently, and the adapter then asks again with the
 * tools written into the prompt.
 */
export function refusesTools(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    error.code === 'bad_request' &&
    /does not support tools|tools? (are |is )?not supported|unsupported.*\btools?\b/i.test(error.message)
  );
}
