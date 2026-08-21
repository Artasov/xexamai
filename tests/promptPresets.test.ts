import {describe, expect, it} from 'vitest';
import {PROMPT_PRESETS} from '../src/renderer/components/settings/AiSettings/PromptSettingsSection';

describe('prompt presets', () => {
    it('provide complete editable prompt triples with stable identifiers', () => {
        expect(new Set(PROMPT_PRESETS.map((preset) => preset.id)).size).toBe(PROMPT_PRESETS.length);
        for (const preset of PROMPT_PRESETS) {
            expect(preset.transcription.trim()).not.toBe('');
            expect(preset.screen.trim()).not.toBe('');
            expect(preset.llm.trim()).not.toBe('');
        }
    });
});
