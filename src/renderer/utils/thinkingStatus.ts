export type ThinkingLanguage = 'en' | 'ru';

export const THINKING_LABELS: Record<ThinkingLanguage, readonly string[]> = {
    en: ['Thinking…', 'Formulating response…', 'Checking details…'],
    ru: ['Думаю…', 'Формирую ответ…', 'Уточняю детали…'],
};

export function resolveThinkingLanguage(
    source: string | undefined,
    uiLanguage?: string,
): ThinkingLanguage {
    const selected = uiLanguage?.trim().toLowerCase();
    if (selected === 'ru' || selected?.startsWith('ru-')) return 'ru';
    if (selected === 'en' || selected?.startsWith('en-')) return 'en';
    return /[\u0400-\u04ff]/u.test(source || '') ? 'ru' : 'en';
}
