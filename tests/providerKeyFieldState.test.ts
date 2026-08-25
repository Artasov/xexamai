import {describe, expect, it} from 'vitest';
import {
    getProviderKeyFieldState,
    normalizeProviderKeyDraftInput,
    SAVED_API_KEY_MASK,
} from '../src/renderer/components/settings/AiSettings/providerKeyFieldState';

describe('provider API key field state', () => {
    it('shows a presentation-only mask for a saved key', () => {
        const state = getProviderKeyFieldState({draft: '', saved: true, editing: false});

        expect(state.displayValue).toBe(SAVED_API_KEY_MASK);
        expect(state.showingSavedMask).toBe(true);
        expect(state.hasDraft).toBe(false);
        expect(state.placeholder).toBe('New key');
    });

    it('opens a saved field as an empty replacement draft', () => {
        const state = getProviderKeyFieldState({draft: '', saved: true, editing: true});

        expect(state.displayValue).toBe('');
        expect(state.showingSavedMask).toBe(false);
        expect(state.hasDraft).toBe(false);
    });

    it('uses a short placeholder when no key has been stored', () => {
        const state = getProviderKeyFieldState({draft: '', saved: false, editing: false});

        expect(state.displayValue).toBe('');
        expect(state.placeholder).toBe('API key');
    });

    it('never mistakes the saved marker or whitespace for a replacement draft', () => {
        const whitespace = getProviderKeyFieldState({draft: '   ', saved: true, editing: false});
        const replacement = getProviderKeyFieldState({
            draft: 'replacement-secret',
            saved: true,
            editing: true,
        });

        expect(whitespace.hasDraft).toBe(false);
        expect(whitespace.displayValue).toBe(SAVED_API_KEY_MASK);
        expect(replacement.hasDraft).toBe(true);
        expect(replacement.displayValue).toBe('replacement-secret');
    });

    it('accepts autofill or the first typed character without leaking the mask into the draft', () => {
        expect(normalizeProviderKeyDraftInput(SAVED_API_KEY_MASK, true)).toBe('');
        expect(normalizeProviderKeyDraftInput(`${SAVED_API_KEY_MASK}s`, true)).toBe('s');
        expect(normalizeProviderKeyDraftInput('sk-replacement', true)).toBe('sk-replacement');
        expect(normalizeProviderKeyDraftInput('ordinary-draft', false)).toBe('ordinary-draft');
    });
});
