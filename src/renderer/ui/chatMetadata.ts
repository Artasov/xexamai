import type {AppSettings} from '@shared/ipc';

export type ChatSource = 'audio' | 'screenshot' | 'text';
export type ChatProvider = 'openai' | 'google' | 'winky' | 'ollama';

type LlmSettings = Pick<AppSettings, 'llmHost' | 'apiLlmModel' | 'llmModel'>;

/** Resolve the provider that will handle the current chat request. */
export function resolveLlmProvider(settings: LlmSettings): ChatProvider {
    if (settings.llmHost === 'local') return 'ollama';

    const model = (settings.apiLlmModel || settings.llmModel || '').trim().toLocaleLowerCase();
    if (model.startsWith('gemini-')) return 'google';
    if (model.startsWith('winky-')) return 'winky';
    return 'openai';
}

export function isChatSource(value: unknown): value is ChatSource {
    return value === 'audio' || value === 'screenshot' || value === 'text';
}

export function isChatProvider(value: unknown): value is ChatProvider {
    return value === 'openai' || value === 'google' || value === 'winky' || value === 'ollama';
}
