/**
 * The wire format of a TypeScript server's output: for every message a
 * "Content-Length: N" header, a blank line, then N bytes holding the JSON
 * and a newline. Requests go the other way as one line of JSON each.
 * Pure, so it is unit-tested without starting a server.
 */

const HEADER_END = Buffer.from('\r\n\r\n');
const LENGTH = /Content-Length: *(\d+)/i;

/** The whole messages at the start of `buffer`, and the bytes after them that belong to a message still arriving. */
export function readFrames(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = [];
  let at = 0;
  for (;;) {
    const headerEnd = buffer.indexOf(HEADER_END, at);
    if (headerEnd === -1) break;
    const length = LENGTH.exec(buffer.toString('latin1', at, headerEnd));
    const bodyStart = headerEnd + HEADER_END.length;
    if (!length) {
      // Not a header (a warning the runtime printed, say): what follows may be one.
      at = bodyStart;
      continue;
    }
    const bodyEnd = bodyStart + Number(length[1]);
    if (bodyEnd > buffer.length) break;
    try {
      messages.push(JSON.parse(buffer.toString('utf8', bodyStart, bodyEnd)));
    } catch {
      // A body that is not JSON is skipped; the next header starts a new message.
    }
    at = bodyEnd;
  }
  return { messages, rest: at === 0 ? buffer : buffer.subarray(at) };
}

/** A request as a TypeScript server reads it: one line of JSON. */
export function writeRequest(seq: number, command: string, args: unknown): string {
  return `${JSON.stringify({ seq, type: 'request', command, arguments: args })}\n`;
}

/** A reply to a request, as far as this client reads it. */
export interface TsResponse {
  type: 'response';
  request_seq: number;
  success: boolean;
  message?: string;
  body?: unknown;
}

export function isResponse(message: unknown): message is TsResponse {
  if (message === null || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  return m.type === 'response' && typeof m.request_seq === 'number' && typeof m.success === 'boolean';
}
