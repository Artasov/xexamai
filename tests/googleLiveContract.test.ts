import {describe, expect, it} from 'vitest';
import {GOOGLE_LIVE_ENDPOINT, GOOGLE_LIVE_MODEL} from '../src/renderer/services/googleLiveContract';

describe('Google Live ephemeral-token contract', () => {
    it('uses the constrained v1beta endpoint required by ephemeral tokens', () => {
        expect(GOOGLE_LIVE_ENDPOINT).toBe(
            'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
        );
        expect(GOOGLE_LIVE_MODEL).toBe('gemini-3.1-flash-live-preview');
    });
});
