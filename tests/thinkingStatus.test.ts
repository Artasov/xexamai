import {describe, expect, it} from 'vitest';
import {resolveThinkingLanguage, THINKING_LABELS} from '../src/renderer/utils/thinkingStatus';

describe('thinking status language', () => {
    it('keeps Russian prompts Russian even when they contain English terms', () => {
        expect(resolveThinkingLanguage('Объясни Redis API и HTTP')).toBe('ru');
        expect(THINKING_LABELS.ru).toContain('Формирую ответ…');
    });

    it('uses English for Latin-only prompts', () => {
        expect(resolveThinkingLanguage('Explain Redis and HTTP')).toBe('en');
        expect(THINKING_LABELS.en).toContain('Formulating response…');
    });

    it('prefers the selected interface language over the prompt language', () => {
        expect(resolveThinkingLanguage('Почему Redis?', 'en')).toBe('en');
        expect(resolveThinkingLanguage('Why Redis?', 'ru-RU')).toBe('ru');
    });
});
