const DEFAULT_MAXIMUM_LINE_BYTES = 64 * 1024;
const DEFAULT_MAXIMUM_EVENT_BYTES = 1024 * 1024;
const DEFAULT_MAXIMUM_BUFFER_BYTES = 128 * 1024;

export interface ParsedSseFrame {
  readonly id: string;
  readonly event: string;
  readonly data: string;
}

export type SseParseErrorCode =
  | 'INVALID_UTF8'
  | 'LINE_TOO_LARGE'
  | 'EVENT_TOO_LARGE'
  | 'BUFFER_TOO_LARGE'
  | 'PARSER_FINISHED';

export class SseParseError extends Error {
  public constructor(public readonly code: SseParseErrorCode) {
    super('Le flux temps réel reçu est invalide ou dépasse les limites autorisées.');
    this.name = 'SseParseError';
  }
}

export interface SseParserOptions {
  readonly maximumLineBytes?: number;
  readonly maximumEventBytes?: number;
  readonly maximumBufferBytes?: number;
}

export class SseParser {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #maximumLineBytes: number;
  readonly #maximumEventBytes: number;
  readonly #maximumBufferBytes: number;
  #buffer = new Uint8Array();
  #id: string | null = null;
  #event: string | null = null;
  #data: string[] = [];
  #hasData = false;
  #eventBytes = 0;
  #finished = false;

  public constructor(options: SseParserOptions = {}) {
    this.#maximumLineBytes = options.maximumLineBytes ?? DEFAULT_MAXIMUM_LINE_BYTES;
    this.#maximumEventBytes = options.maximumEventBytes ?? DEFAULT_MAXIMUM_EVENT_BYTES;
    this.#maximumBufferBytes = options.maximumBufferBytes ?? DEFAULT_MAXIMUM_BUFFER_BYTES;
  }

  public push(chunk: Uint8Array): readonly ParsedSseFrame[] {
    if (this.#finished) throw new SseParseError('PARSER_FINISHED');
    this.#append(chunk);
    const frames = this.#consumeCompleteLines(false);
    if (this.#buffer.byteLength > this.#maximumBufferBytes) throw new SseParseError('BUFFER_TOO_LARGE');
    if (this.#buffer.byteLength > this.#maximumLineBytes) throw new SseParseError('LINE_TOO_LARGE');
    return Object.freeze(frames);
  }

  public finish(): readonly ParsedSseFrame[] {
    if (this.#finished) return Object.freeze([]);
    this.#finished = true;
    this.#consumeCompleteLines(true);
    this.#resetEvent();
    this.#buffer = new Uint8Array();
    return Object.freeze([]);
  }

  #append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.byteLength);
    this.#buffer = merged;
  }

  #consumeCompleteLines(includeFinalLine: boolean): ParsedSseFrame[] {
    const frames: ParsedSseFrame[] = [];
    for (;;) {
      const boundary = findLineBoundary(this.#buffer, includeFinalLine);
      if (boundary === null) break;
      const lineBytes = this.#buffer.slice(0, boundary.lineEnd);
      if (lineBytes.byteLength > this.#maximumLineBytes) throw new SseParseError('LINE_TOO_LARGE');
      this.#buffer = this.#buffer.slice(boundary.nextOffset);
      const line = this.#decode(lineBytes);
      const frame = this.#processLine(line, lineBytes.byteLength);
      if (frame !== null) frames.push(frame);
      if (boundary.final) break;
    }
    return frames;
  }

  #decode(value: Uint8Array): string {
    try {
      return this.#decoder.decode(value);
    } catch {
      throw new SseParseError('INVALID_UTF8');
    }
  }

  #processLine(line: string, byteLength: number): ParsedSseFrame | null {
    if (line === '') return this.#dispatch();
    this.#eventBytes += byteLength;
    if (this.#eventBytes > this.#maximumEventBytes) throw new SseParseError('EVENT_TOO_LARGE');
    if (line.startsWith(':')) return null;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') {
      if (!value.includes('\0')) this.#id = value;
    } else if (field === 'event') {
      this.#event = value;
    } else if (field === 'data') {
      this.#hasData = true;
      this.#data.push(value);
    }
    return null;
  }

  #dispatch(): ParsedSseFrame | null {
    const frame = this.#id !== null && this.#id !== '' && this.#event !== null && this.#event !== '' && this.#hasData
      ? Object.freeze({ id: this.#id, event: this.#event, data: this.#data.join('\n') })
      : null;
    this.#resetEvent();
    return frame;
  }

  #resetEvent(): void {
    this.#id = null;
    this.#event = null;
    this.#data = [];
    this.#hasData = false;
    this.#eventBytes = 0;
  }
}

interface LineBoundary {
  readonly lineEnd: number;
  readonly nextOffset: number;
  readonly final: boolean;
}

function findLineBoundary(buffer: Uint8Array, includeFinalLine: boolean): LineBoundary | null {
  for (let index = 0; index < buffer.byteLength; index += 1) {
    const byte = buffer[index];
    if (byte === 0x0a) return { lineEnd: index, nextOffset: index + 1, final: false };
    if (byte === 0x0d) {
      if (index + 1 === buffer.byteLength && !includeFinalLine) return null;
      const hasLineFeed = buffer[index + 1] === 0x0a;
      return { lineEnd: index, nextOffset: index + (hasLineFeed ? 2 : 1), final: false };
    }
  }
  if (includeFinalLine && buffer.byteLength > 0) {
    return { lineEnd: buffer.byteLength, nextOffset: buffer.byteLength, final: true };
  }
  return null;
}
