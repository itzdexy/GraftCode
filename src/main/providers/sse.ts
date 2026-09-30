export interface SseMessage {
  event: string | null;
  data: string;
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      // Split on \n, \r\n or a lone \r (all valid SSE line endings).
      while ((index = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, index);
        const skip = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        // A trailing lone \r may be the first half of \r\n split across chunks.
        if (buffer[index] === '\r' && index + 1 === buffer.length) break;
        buffer = buffer.slice(index + skip);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer.replace(/\r$/, '');
  } finally {
    reader.releaseLock();
  }
}

/** Parses a text/event-stream body per the WHATWG algorithm (data, event, comments). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  let data: string[] = [];
  let event: string | null = null;
  for await (const line of lines(body)) {
    if (line === '') {
      if (data.length > 0) yield { event, data: data.join('\n') };
      data = [];
      event = null;
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (data.length > 0) yield { event, data: data.join('\n') };
}

/** Parses newline-delimited JSON (Ollama's streaming format). */
export async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  for await (const line of lines(body)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      yield JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new Error(`Malformed streaming JSON line: ${trimmed.slice(0, 120)}`, { cause: error });
    }
  }
}
