import {describe, expect, it} from 'vitest';
import {clampAnswerFontSize} from '@renderer/hooks/useAnswerFontSize';

describe('clampAnswerFontSize', () => {
    it('normalizes persisted and wheel-driven values to the supported range', () => {
        expect(clampAnswerFontSize(Number.NaN)).toBe(14);
        expect(clampAnswerFontSize(1)).toBe(10);
        expect(clampAnswerFontSize(17.6)).toBe(18);
        expect(clampAnswerFontSize(100)).toBe(24);
    });
});
