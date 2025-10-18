import {getConfig} from '../config.service';
import {withRetry} from '../retry.service';
import {DefaultTimeoutConfig} from '../timeout.config';
import {DEFAULT_SCREEN_PROMPT} from '../../../shared/ipc';
import {
    askChatWithOpenAI,
    askChatStreamWithOpenAI,
    processScreenImageWithOpenAI,
} from './providers/openaiProvider';
import {
    askChatWithGoogle,
    askChatStreamWithGoogle,
    processScreenImageWithGoogle,
} from './providers/googleProvider';
import {
    askChatWithLocalModel,
    askChatStreamWithLocalModel,
} from './providers/localProvider';

const ALLOWED_LOCAL_MODELS = new Set<string>([
    'gpt-oss:120b',
    'gpt-oss:20b',
    'gemma3:27b',
    'gemma3:12b',
    'gemma3:4b',
    'gemma3:1b',
    'deepseek-r1:8b',
    'qwen3-coder:30b',
    'qwen3:30b',
    'qwen3:8b',
    'qwen3:4b',
]);

function isLocalModel(model?: string): boolean {
    return typeof model === 'string' && ALLOWED_LOCAL_MODELS.has(model);
}

function isGoogleModel(model?: string): boolean {
    if (typeof model !== 'string') return false;
    return model.startsWith('gemini') || model.startsWith('google-');
}

const LOCAL_LLM_TIMEOUT_MS = 600000; // 600s only for local LLM
const SCREEN_OPENAI_MODEL = 'gpt-4o-mini';
const SCREEN_GOOGLE_MODEL = 'gemini-2.5-flash';
const SCREEN_SYSTEM_PROMPT = 'You analyze screenshots to assist with technical interviews. Follow the user\'s instructions exactly and keep responses concise.';


export async function processScreenImage(image: Buffer, mime: string): Promise<string> {
    const cfg = getConfig();
    const basePrompt = (cfg.screenProcessingPrompt || DEFAULT_SCREEN_PROMPT).trim() || DEFAULT_SCREEN_PROMPT;
    const provider = cfg.screenProcessingModel || 'openai';
    const timeoutMs = cfg.screenProcessingTimeoutMs || cfg.apiLlmTimeoutMs || DefaultTimeoutConfig.chatgptTimeoutMs;

    if (provider === 'google') {
        return withRetry(
            () => processScreenImageWithGoogle(image, mime, basePrompt, cfg, SCREEN_GOOGLE_MODEL, SCREEN_SYSTEM_PROMPT),
            cfg.retryConfig,
            'Google screen processing',
            timeoutMs
        );
    }

    const openAiPrompt = `${basePrompt}\n\nScreenshot attached below. Respond according to the instructions.`;
    return withRetry(
        () => processScreenImageWithOpenAI(image, mime, openAiPrompt, cfg, SCREEN_OPENAI_MODEL, SCREEN_SYSTEM_PROMPT),
        cfg.retryConfig,
        'OpenAI screen processing',
        timeoutMs
    );
}

export async function askChat(prompt: string): Promise<string> {
    const cfg = getConfig();

    if (isGoogleModel(cfg.chatModel)) {
        if (!cfg.googleApiKey) throw new Error('GOOGLE_API_KEY is not set');
        return withRetry(
            () => askChatWithGoogle(prompt, cfg),
            cfg.retryConfig,
            'Google completion',
            cfg.apiLlmTimeoutMs || DefaultTimeoutConfig.chatgptTimeoutMs
        );
    }

    if (isLocalModel(cfg.chatModel)) {
        return withRetry(
            () => askChatWithLocalModel(prompt, cfg),
            cfg.retryConfig,
            'Local GPT-OSS completion',
            LOCAL_LLM_TIMEOUT_MS
        );
    }

    return withRetry(
        () => askChatWithOpenAI(prompt, cfg),
        cfg.retryConfig,
        'ChatGPT completion',
        cfg.apiLlmTimeoutMs || DefaultTimeoutConfig.chatgptTimeoutMs
    );
}

export async function askChatStream(
    prompt: string,
    onDelta: (delta: string) => void,
    onDone?: () => void,
    options?: { signal?: AbortSignal; shouldCancel?: () => boolean }
): Promise<void> {
    const cfg = getConfig();
    
    if (isGoogleModel(cfg.chatModel)) {
        if (!cfg.googleApiKey) throw new Error('GOOGLE_API_KEY is not set');
        await withRetry(
            () => askChatStreamWithGoogle(prompt, cfg, onDelta, options),
            cfg.retryConfig,
            'Google streaming'
        );
        onDone?.();
        return;
    }

    if (isLocalModel(cfg.chatModel)) {
        await withRetry(
            () => askChatStreamWithLocalModel(prompt, cfg, onDelta, options),
            cfg.retryConfig,
            'Local GPT-OSS streaming'
        );
        onDone?.();
        return;
    }

    await withRetry(
        () => askChatStreamWithOpenAI(prompt, cfg, onDelta, options),
        cfg.retryConfig,
        'ChatGPT streaming'
    );

    onDone?.();
}
