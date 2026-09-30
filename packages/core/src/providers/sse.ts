/**
 * Server-Sent Events parsing.
 *
 * Shared by the OpenAI and Anthropic wire formats. Handles chunk boundaries
 * mid-line, CRLF and LF, multi-line `data:` payloads and `[DONE]`.
 */

export interface SseEvent {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

/** Decode a byte stream into a stream of `SseEvent`s. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = findBoundary(buffer);
      while (boundary) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseEvent(rawEvent);
        if (event) yield event;
        boundary = findBoundary(buffer);
      }
    }

    buffer += decoder.decode();
    const tail = parseEvent(buffer);
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock?.();
  }
}

function findBoundary(buffer: string): { index: number; length: number } | null {
  // Accept CRLFCRLF, LFLF and LFLF pairs; also tolerate bare CR.
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  const cr = buffer.indexOf("\r\r");
  const candidates = [
    crlf >= 0 ? { index: crlf, length: 4 } : null,
    lf >= 0 ? { index: lf, length: 2 } : null,
    cr >= 0 ? { index: cr, length: 2 } : null,
  ].filter((c): c is { index: number; length: number } => c !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.index <= b.index ? a : b));
}

function parseEvent(raw: string): SseEvent | null {
  const lines = raw.split(/\r\n|\n|\r/);
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        dataLines.push(value);
        break;
      case "event":
        event = value;
        break;
      case "id":
        id = value;
        break;
      case "retry": {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) retry = parsed;
        break;
      }
      default:
        break;
    }
  }

  if (dataLines.length === 0 && event === undefined) return null;
  return { data: dataLines.join("\n"), ...(event ? { event } : {}), ...(id ? { id } : {}), ...(retry ? { retry } : {}) };
}

export const SSE_DONE = "[DONE]";

/** Read a streaming body that is *not* SSE (Google's `streamGenerateContent`). */
export async function* parseJsonLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload && payload !== SSE_DONE) yield safeJsonParse(payload);
        } else if (line) {
          yield safeJsonParse(line);
        }
        index = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== SSE_DONE) yield safeJsonParse(payload);
    } else if (tail) {
      yield safeJsonParse(tail);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock?.();
  }
}

export function safeJsonParse<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
