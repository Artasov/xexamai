// noinspection JSUnusedGlobalSymbols

export const FAST_WHISPER_PORT = 8868;
export const FAST_WHISPER_BASE_URL = `http://127.0.0.1:${FAST_WHISPER_PORT}`;
export const FAST_WHISPER_HEALTH_ENDPOINT = `${FAST_WHISPER_BASE_URL}/health`;

export const TRANSCRIPTION_MODES = {
    API: 'api',
    LOCAL: 'local',
} as const;

export const LLM_HOSTS = {
    API: 'api',
    LOCAL: 'local',
} as const;

export const OPENAI_TRANSCRIBE_MODELS = [
    'gpt-4o-mini-transcribe',
    'gpt-4o-transcribe',
    'whisper-1',
] as const;

export const GOOGLE_TRANSCRIBE_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
] as const;

export const TRANSCRIBE_API_MODELS = [
    ...OPENAI_TRANSCRIBE_MODELS,
    ...GOOGLE_TRANSCRIBE_MODELS,
] as const;

export const LOCAL_TRANSCRIBE_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'] as const;

export const LOCAL_TRANSCRIBE_MODEL_DETAILS = {
    tiny: {label: 'Tiny', size: '~75MB'},
    base: {label: 'Base', size: '~141MB'},
    small: {label: 'Small', size: '~463MB'},
    medium: {label: 'Medium', size: '~1.42GB'},
    'large-v3': {label: 'Large', size: '~3GB'},
} as const;

export const LOCAL_TRANSCRIBE_ALIASES = {
    large: 'large-v3',
    'large-v2': 'large-v3',
} as const;

export const OPENAI_LLM_MODELS = [
    'gpt-4.1-nano',
    'gpt-4.1-mini',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'chatgpt-4o-latest',
    'gpt-3.5-turbo',
] as const;

export const GEMINI_LLM_MODELS = [
    'gemini-3.0-pro',
    'gemini-3.0-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.0-pro',
    'gemini-2.0-flash',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
] as const;

export const API_LLM_MODELS = [...OPENAI_LLM_MODELS, ...GEMINI_LLM_MODELS] as const;

export const LOCAL_LLM_MODELS = [
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
] as const;

export const LOCAL_LLM_SIZE_HINTS: Record<string, string> = {
    'gpt-oss:120b': '~90GB',
    'gpt-oss:20b': '~13GB',
    'gemma3:27b': '~21GB',
    'gemma3:12b': '~9.5GB',
    'gemma3:4b': '~2.2GB',
    'gemma3:1b': '~815MB',
    'deepseek-r1:8b': '~5.5GB',
    'qwen3-coder:30b': '~23GB',
    'qwen3:30b': '~23GB',
    'qwen3:8b': '~5.2GB',
    'qwen3:4b': '~2.5GB',
};

export type ApiTranscribeModel = (typeof TRANSCRIBE_API_MODELS)[number];
export type LocalTranscribeModel = (typeof LOCAL_TRANSCRIBE_MODELS)[number];
export type ApiLlmModel = (typeof API_LLM_MODELS)[number];
export type LocalLlmModel = (typeof LOCAL_LLM_MODELS)[number];
