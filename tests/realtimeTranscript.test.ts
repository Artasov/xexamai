import {describe, expect, it} from 'vitest';
import {reconcileRealtimeTranscript} from '../src/renderer/utils/realtimeTranscript';

describe('reconcileRealtimeTranscript', () => {
    it('replaces a corrected partial instead of duplicating it', () => {
        expect(reconcileRealtimeTranscript('Question hello worl', 'hello worl', 'hello world'))
            .toBe('Question hello world');
        expect(reconcileRealtimeTranscript('Question hello world', 'hello world', 'hello word'))
            .toBe('Question hello word');
    });

    it('appends a disjoint next transcription segment', () => {
        expect(reconcileRealtimeTranscript('Question hello', 'hello', 'from audio'))
            .toBe('Question hello from audio');
    });

    it('does not overwrite user edits after a prior partial', () => {
        expect(reconcileRealtimeTranscript('hello typed suffix', 'hello', 'hello world'))
            .toBe('hello typed suffix hello world');
    });
});
