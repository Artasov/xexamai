import {describe, expect, it} from 'vitest';
import {StreamFrameParser} from '../src/renderer/utils/streamFrames';

describe('StreamFrameParser', () => {
    it('flushes a final NDJSON fragment without a trailing newline', () => {
        const parser = new StreamFrameParser('ndjson');
        expect(parser.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
        expect(parser.finish(':2}')).toEqual(['{"b":2}']);
    });

    it('handles CRLF split across SSE chunks and the final event', () => {
        const parser = new StreamFrameParser('sse');
        expect(parser.push('event: message\r\ndata: {"a":1}\r')).toEqual([]);
        expect(parser.push('\n\r\ndata: [DO')).toEqual(['{"a":1}']);
        expect(parser.finish('NE]')).toEqual(['[DONE]']);
    });
});
