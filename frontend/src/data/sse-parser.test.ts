// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { SseParseError, SseParser } from './sse-parser.js';

const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

describe('bounded incremental SSE parser', () => {
  it('parses LF, CRLF, comments, unknown fields, and two frames per chunk', () => {
    const parser = new SseParser();
    expect(parser.push(bytes(
      ': heartbeat\r\nid: a\r\nevent: Alpha\r\nunknown: ignored\r\ndata: one\r\ndata: two\r\n\r\n'
      + 'id:b\nevent:Beta\ndata:\n\n',
    ))).toEqual([
      { id: 'a', event: 'Alpha', data: 'one\ntwo' },
      { id: 'b', event: 'Beta', data: '' },
    ]);
  });

  it('handles every split point of a multibyte UTF-8 frame', () => {
    const encoded = bytes('id: evt-é\nevent: Message\ndata: fusée 🚀\n\n');
    for (let split = 0; split <= encoded.length; split += 1) {
      const parser = new SseParser();
      expect([
        ...parser.push(encoded.slice(0, split)),
        ...parser.push(encoded.slice(split)),
      ]).toEqual([{ id: 'evt-é', event: 'Message', data: 'fusée 🚀' }]);
    }
  });

  it('does not dispatch partial, missing-identity, or NUL-identified frames', () => {
    const parser = new SseParser();
    expect(parser.push(bytes('data: ignored\n\nid: only-id\ndata: ignored\n\nid: bad\0id\nevent: Bad\ndata: ignored\n\n'))).toEqual([]);
    expect(parser.push(bytes('id: partial\nevent: Partial\ndata: pending'))).toEqual([]);
    expect(parser.finish()).toEqual([]);
  });

  it('rejects malformed UTF-8 and bounded line, event, and pending buffers', () => {
    expect(() => new SseParser().push(Uint8Array.of(0xc3, 0x28, 0x0a))).toThrow(SseParseError);
    expect(() => new SseParser({ maximumLineBytes: 4 }).push(bytes('id: abc\n'))).toThrow(expect.objectContaining({ code: 'LINE_TOO_LARGE' }));
    expect(() => new SseParser({ maximumEventBytes: 12 }).push(bytes('id:a\nevent:b\ndata:long\n\n'))).toThrow(expect.objectContaining({ code: 'EVENT_TOO_LARGE' }));
    expect(() => new SseParser({ maximumBufferBytes: 4 }).push(bytes('abcde'))).toThrow(expect.objectContaining({ code: 'BUFFER_TOO_LARGE' }));
  });

  it('rejects reuse after finish and freezes accepted frames', () => {
    const parser = new SseParser();
    const [frame] = parser.push(bytes('id:a\nevent:A\ndata:{}\n\n'));
    expect(Object.isFrozen(frame)).toBe(true);
    parser.finish();
    expect(() => parser.push(bytes('id:b\n'))).toThrow(expect.objectContaining({ code: 'PARSER_FINISHED' }));
  });
});
