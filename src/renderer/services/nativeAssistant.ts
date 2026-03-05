import {invoke} from '@tauri-apps/api/core';
import {
    AskChatRequest,
    AppSettings,
    AssistantResponse,
    ChatHistoryMessage,
    ProcessAudioArgs,
    ScreenProcessRequest,
    ScreenProcessResponse,
    StopStreamRequest,
} from '@shared/ipc';
import {
    GEMINI_LLM_MODELS,
    GOOGLE_TRANSCRIBE_MODELS,
    LOCAL_LLM_MODELS,
    LOCAL_TRANSCRIBE_MODELS,
    OPENAI_LLM_MODELS,
    OPENAI_TRANSCRIBE_MODELS,
    WINKY_LLM_MODELS,
    WINKY_TRANSCRIBE_MODELS,
} from '@shared/constants';
import {logRequest, previewText} from './nativeAssistant.helpers';
import {fetchWithTimeout, ollamaAxios} from './nativeAssistant.network';
import {getAuthApiBaseUrl, getSiteBaseUrl, getWsBaseUrl} from '@shared/appUrls';
import {authClient} from './authClient';

type StreamEventPayloads = {
    transcript: { requestId?: string; delta: string };
    delta: { requestId?: string; delta: string };
    done: { requestId?: string; full: string };
    error: { requestId?: string; error: string };
};

type StreamListener<T> = (event: unknown, payload: T) => void;

type StreamEvents = {
    [K in keyof StreamEventPayloads]: Set<StreamListener<StreamEventPayloads[K]>>;
};

const streamEvents: StreamEvents = {
    transcript: new Set(),
    delta: new Set(),
    done: new Set(),
    error: new Set(),
};

function addStreamListener<K extends keyof StreamEventPayloads>(
    key: K,
    listener: StreamListener<StreamEventPayloads[K]>
) {
    streamEvents[key].add(listener);
}

function removeStreamListener<K extends keyof StreamEventPayloads>(
    key: K,
    listener?: StreamListener<StreamEventPayloads[K]>
) {
    if (listener) {
        streamEvents[key].delete(listener);
    } else {
        streamEvents[key].clear();
    }
}

const activeStreams = new Map<string, AbortController>();

const streamErrorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

function runWithActiveStream(
    requestId: string,
    runner: (controller: AbortController) => Promise<void>
): AbortController {
    const controller = new AbortController();
    activeStreams.set(requestId, controller);
    runner(controller)
        .catch((error) => {
            if (controller.signal.aborted) return;
            const message = streamErrorMessage(error);
            logRequest('llm:stream', 'error', {requestId, error: message});
            emit('error', {requestId, error: message});
        })
        .finally(() => {
            activeStreams.delete(requestId);
        });
    return controller;
}

const GOOGLE_TRANSCRIBE_SET = new Set(GOOGLE_TRANSCRIBE_MODELS as readonly string[]);
const GEMINI_LLM_SET = new Set(GEMINI_LLM_MODELS as readonly string[]);
const WINKY_TRANSCRIBE_SET = new Set(WINKY_TRANSCRIBE_MODELS as readonly string[]);
const WINKY_LLM_SET = new Set(WINKY_LLM_MODELS as readonly string[]);
const DEFAULT_LOCAL_TRANSCRIBE = LOCAL_TRANSCRIBE_MODELS[0] ?? 'base';
const DEFAULT_API_TRANSCRIBE = OPENAI_TRANSCRIBE_MODELS[0] ?? 'gpt-4o-mini-transcribe';
const DEFAULT_API_LLM = OPENAI_LLM_MODELS[0] ?? 'gpt-4.1-nano';
const DEFAULT_LOCAL_LLM = LOCAL_LLM_MODELS[0] ?? 'gpt-oss:20b';

const OPENAI_BASE =
    (import.meta.env.VITE_OPENAI_BASE_URL as string | undefined)?.replace(/\/$/, '') ||
    'https://api.openai.com';
const SCREEN_OPENAI_MODEL = 'gpt-4o-mini';
const SCREEN_GEMINI_MODEL = 'gemini-1.5-flash';
const MAX_HISTORY_MESSAGES = 40;
const WINKY_CREDITS_TOPUP_PATH = '/profile/general?open_top_up=1';

const supportsCustomTemperature = (model: string): boolean => !model.toLowerCase().startsWith('gpt-5');

const normalizeChatHistory = (history?: ChatHistoryMessage[]): ChatHistoryMessage[] => {
    if (!Array.isArray(history)) return [];
    return history
        .filter((item) => (
            !!item &&
            (item.role === 'user' || item.role === 'assistant') &&
            typeof item.content === 'string' &&
            item.content.trim().length > 0
        ))
        .slice(-MAX_HISTORY_MESSAGES);
};

function emit<K extends keyof StreamEventPayloads>(key: K, payload: StreamEventPayloads[K]) {
    const listeners = streamEvents[key];
    for (const listener of listeners) {
        try {
            listener({}, payload);
        } catch (error) {
            console.warn('[assistantBridge] listener failed', error);
        }
    }
}

async function loadSettings(): Promise<AppSettings> {
    return invoke<AppSettings>('config_get');
}

function ensureOpenAiKey(settings: AppSettings): string {
    const key = settings.openaiApiKey?.trim();
    if (!key) {
        throw new Error('OPENAI_API_KEY is not set');
    }
    return key;
}

function ensureGoogleKey(settings: AppSettings): string {
    const key = settings.googleApiKey?.trim();
    if (!key) {
        throw new Error('Provide a Google AI API key first');
    }
    return key;
}

function ensureAccessToken(): string {
    const token = authClient.getTokens()?.access?.trim();
    if (!token) {
        throw new Error('Sign in to use Winky models.');
    }
    return token;
}

function createCreditsError(message?: string): Error {
    const topUpUrl = `${getSiteBaseUrl()}${WINKY_CREDITS_TOPUP_PATH}`;
    const text = message?.trim() || `Not enough credits. Top up your balance: ${topUpUrl}`;
    const error = new Error(text);
    (error as any).code = 'not_enough_credits';
    (error as any).status = 402;
    return error;
}

function mapWinkyModelToLevel(model: string): 'low' | 'mid' | 'high' {
    if (model === 'winky-high') return 'high';
    if (model === 'winky-mid') return 'mid';
    return 'low';
}

function getAudioFileNameByMime(mime: string): string {
    const normalized = (mime || '').toLowerCase();
    if (normalized.includes('wav')) return 'audio.wav';
    if (normalized.includes('mp3') || normalized.includes('mpeg')) return 'audio.mp3';
    if (normalized.includes('ogg')) return 'audio.ogg';
    return 'audio.webm';
}

function buildWinkyPrompt(
    prompt: string,
    settings: AppSettings,
    history?: ChatHistoryMessage[]
): string {
    const parts: string[] = [];
    const systemPrompt = (settings.llmPrompt || '').trim();
    if (systemPrompt) {
        parts.push(systemPrompt);
    }

    const normalizedHistory = normalizeChatHistory(history);
    if (normalizedHistory.length) {
        const historyText = normalizedHistory
            .map((item) => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${item.content}`)
            .join('\n\n');
        parts.push(`Conversation history:\n${historyText}`);
    }

    parts.push(prompt);
    return parts.filter(Boolean).join('\n\n').trim();
}

const buildTranscriptionPrompt = (settings: AppSettings): string | undefined => {
    const userPrompt = settings.transcriptionPrompt?.trim();
    const guard =
        'Transcribe speech verbatim in the original spoken language. Do not translate, summarise, or answer questions.';
    if (userPrompt) {
        return `${userPrompt}\n\n${guard}`;
    }
    return guard;
};

type LlmTarget = {
    host: 'local' | 'api';
    model: string;
};

function resolveLlmTarget(settings: AppSettings): LlmTarget {
    const host: LlmTarget['host'] = settings.llmHost === 'local' ? 'local' : 'api';
    const model =
        host === 'local'
            ? settings.localLlmModel || settings.llmModel || DEFAULT_LOCAL_LLM
            : settings.apiLlmModel || settings.llmModel || DEFAULT_API_LLM;

    return {host, model};
}

async function transcribeWithOpenAi(
    buffer: ArrayBuffer,
    mime: string,
    filename: string,
    settings: AppSettings,
    model?: string
): Promise<string> {
    const apiKey = ensureOpenAiKey(settings);
    const resolvedModel = model || settings.transcriptionModel || DEFAULT_API_TRANSCRIBE;
    const prompt = buildTranscriptionPrompt(settings);

    logRequest('transcribe:openai', 'start', {model: resolvedModel, mime});

    try {
        const result = await invoke<{ text: string }>('transcribe_audio', {
            request: {
                mode: 'api',
                model: resolvedModel,
                api_key: apiKey,
                audio_data: Array.from(new Uint8Array(buffer)),
                mime_type: mime || 'audio/wav',
                filename,
                prompt: prompt || undefined,
            },
        });

        const text = result.text || '';
        logRequest('transcribe:openai', 'ok', {
            model: resolvedModel,
            textPreview: previewText(text),
        });
        return text;
    } catch (error: any) {
        logRequest('transcribe:openai', 'error', {error: error.message || String(error)});
        throw new Error(error.message || 'Transcription failed');
    }
}

const extractSpeechText = (payload: any): string => {
    if (!payload) return '';
    if (typeof payload === 'string') return payload;
    // FastWhisper returns { text: "..." }
    if (typeof payload.text === 'string') return payload.text;
    // Some APIs return transcription field
    if (typeof payload.transcription === 'string') return payload.transcription;
    // Some APIs return result field
    if (typeof payload.result === 'string') return payload.result;
    // Check nested data
    if (payload.data) return extractSpeechText(payload.data);
    // Check if it's an array with text
    if (Array.isArray(payload) && payload.length > 0) {
        const first = payload[0];
        if (typeof first === 'string') return first;
        if (first?.text) return first.text;
    }
    return '';
};

const coerceStreamText = (value: any): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value
            .map((item: any) => {
                if (typeof item === 'string') return item;
                if (typeof item?.text === 'string') return item.text;
                if (typeof item?.content === 'string') return item.content;
                if (typeof item?.delta === 'string') return item.delta;
                return '';
            })
            .join('');
    }
    if (typeof value?.text === 'string') return value.text;
    if (typeof value?.content === 'string') return value.content;
    if (typeof value?.delta === 'string') return value.delta;
    return '';
};

const extractOpenAiDelta = (payload: any): string => {
    const deltaRaw =
        payload?.choices?.[0]?.delta?.content ??
        (payload?.type === 'response.output_text.delta' ? payload?.delta : undefined) ??
        payload?.delta ??
        payload?.output_text;
    return coerceStreamText(deltaRaw);
};

const extractGeminiChunkText = (payload: any): string => {
    const candidates = payload?.candidates;
    if (Array.isArray(candidates) && candidates.length) {
        const parts = candidates[0]?.content?.parts;
        if (Array.isArray(parts)) {
            const text = parts
                .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
                .filter(Boolean)
                .join('');
            if (text) return text;
        }
    }
    return coerceStreamText(payload?.text) || extractSpeechText(payload);
};

const appendStreamingDelta = (current: string, nextChunk: string): { full: string; delta: string } => {
    if (!nextChunk) {
        return {full: current, delta: ''};
    }
    if (!current) {
        return {full: nextChunk, delta: nextChunk};
    }
    if (nextChunk.startsWith(current)) {
        const delta = nextChunk.slice(current.length);
        return {full: current + delta, delta};
    }
    if (current.endsWith(nextChunk)) {
        return {full: current, delta: ''};
    }
    return {full: current + nextChunk, delta: nextChunk};
};

async function transcribeWithLocal(
    buffer: ArrayBuffer,
    mime: string,
    filename: string,
    settings: AppSettings
): Promise<string> {
    // Validate buffer size
    if (buffer.byteLength < 1000) {
        throw new Error(`Audio buffer too small: ${buffer.byteLength} bytes. Audio may be empty or invalid.`);
    }

    // Validate WAV header if it's a WAV file
    if (mime === 'audio/wav' || mime === 'audio/wave') {
        const view = new DataView(buffer);
        if (buffer.byteLength >= 12) {
            const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
            const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
            if (riff !== 'RIFF' || wave !== 'WAVE') {
                throw new Error(`Invalid WAV file: RIFF=${riff}, WAVE=${wave}`);
            }
        }
    }

    const model = (settings.localWhisperModel || DEFAULT_LOCAL_TRANSCRIBE).toLowerCase();

    logRequest('transcribe:local', 'start', {model, mime, bufferSize: buffer.byteLength});

    try {
        const result = await invoke<{ text: string }>('transcribe_audio', {
            request: {
                mode: 'local',
                model,
                api_key: undefined,
                audio_data: Array.from(new Uint8Array(buffer)),
                mime_type: mime || 'audio/wav',
                filename,
                prompt: undefined, // Don't send prompt to FastWhisper
            },
        });

        const text = result.text || '';

        // Check if we got prompt text instead of transcription
        if (text) {
            const lower = text.toLowerCase();
            const isPromptText = lower.includes('transcribe verbatim')
                || lower.includes('original spoken language')
                || lower.includes('do not translate')
                || lower.includes('do not summarise')
                || lower.includes('transcribe speech');

            if (isPromptText) {
                logRequest('transcribe:local', 'error', {
                    message: 'FastWhisper returned prompt text instead of transcription',
                    receivedText: text,
                    bufferSize: buffer.byteLength,
                });
                throw new Error('FastWhisper returned prompt text instead of transcription. The audio file may be empty, too short, or contain no speech. Please check that audio is being captured correctly.');
            }
        }

        if (!text || text.trim().length === 0) {
            logRequest('transcribe:local', 'error', {
                message: 'Empty transcription from FastWhisper',
                bufferSize: buffer.byteLength,
            });
            throw new Error('FastWhisper returned empty transcription. The audio file may be empty, too short, or contain no speech.');
        }

        logRequest('transcribe:local', 'ok', {
            model,
            textPreview: previewText(text),
        });
        return text;
    } catch (error: any) {
        logRequest('transcribe:local', 'error', {error: error.message || String(error)});
        throw error;
    }
}

async function transcribeWithGoogle(
    buffer: ArrayBuffer,
    mime: string,
    settings: AppSettings,
    model?: string
): Promise<string> {
    const key = ensureGoogleKey(settings);
    const resolvedModel = model || settings.transcriptionModel || DEFAULT_API_TRANSCRIBE;

    // Validate buffer size
    if (buffer.byteLength < 1000) {
        throw new Error(`Audio buffer too small: ${buffer.byteLength} bytes. Audio may be empty or invalid.`);
    }

    // Validate WAV header if it's a WAV file
    if (mime === 'audio/wav' || mime === 'audio/wave') {
        const view = new DataView(buffer);
        if (buffer.byteLength >= 12) {
            const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
            const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
            if (riff !== 'RIFF' || wave !== 'WAVE') {
                throw new Error(`Invalid WAV file: RIFF=${riff}, WAVE=${wave}`);
            }
        }
    }

    const prompt = buildTranscriptionPrompt(settings);

    logRequest('transcribe:google', 'start', {
        model: resolvedModel,
        mime,
        bufferSize: buffer.byteLength,
    });

    try {
        const result = await invoke<{ text: string }>('transcribe_audio', {
            request: {
                mode: 'google',
                model: resolvedModel,
                api_key: key,
                audio_data: Array.from(new Uint8Array(buffer)),
                mime_type: mime || 'audio/wav',
                filename: 'audio.wav',
                prompt: prompt || undefined,
            },
        });

        const text = result.text || '';

        if (!text || text.trim().length === 0) {
            logRequest('transcribe:google', 'error', {
                message: 'Empty transcription from Google',
                bufferSize: buffer.byteLength,
            });
            throw new Error('Google returned empty transcription. The audio file may be empty, too short, or contain no speech.');
        }

        logRequest('transcribe:google', 'ok', {
            model: resolvedModel,
            textPreview: previewText(text),
        });
        return text;
    } catch (error: any) {
        logRequest('transcribe:google', 'error', {error: error.message || String(error)});
        throw error;
    }
}

async function chatCompletion(
    prompt: string,
    settings: AppSettings,
    model?: string,
    history?: ChatHistoryMessage[],
    signal?: AbortSignal
): Promise<string> {
    const apiKey = ensureOpenAiKey(settings);
    const url = `${OPENAI_BASE}/v1/chat/completions`;
    const resolvedModel = model || settings.llmModel || settings.apiLlmModel || DEFAULT_API_LLM;
    const systemPrompt = (settings.llmPrompt || '').trim();
    const normalizedHistory = normalizeChatHistory(history);
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
        messages.push({role: 'system', content: systemPrompt});
    }
    for (const item of normalizedHistory) {
        messages.push({role: item.role, content: item.content});
    }
    messages.push({role: 'user', content: prompt});

    const body: any = {
        model: resolvedModel,
        messages,
    };
    if (supportsCustomTemperature(resolvedModel)) {
        body.temperature = 0.3;
    }
    logRequest('llm:openai', 'start', {model: body.model, promptPreview: previewText(prompt)});
    let logged = false;
    try {
        const response = await fetchWithTimeout(
            url,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal,
            },
            settings.apiLlmTimeoutMs
        );
        const data = await response.json().catch(async () => ({text: await response.text()}));
        if (!response.ok) {
            logRequest('llm:openai', 'error', {status: response.status, data});
            logged = true;
            const message = typeof data === 'string'
                ? data
                : data?.error?.message || 'LLM request failed';
            throw new Error(message);
        }
        const content = data?.choices?.[0]?.message?.content?.trim() || '';
        logRequest('llm:openai', 'ok', {
            model: body.model,
            status: response.status,
            promptPreview: previewText(prompt),
            responsePreview: previewText(content),
        });
        return content;
    } catch (error) {
        const aborted = signal?.aborted || (error instanceof DOMException && error.name === 'AbortError');
        if (!aborted && !logged) {
            logRequest('llm:openai', 'error', {
                model: body.model,
                promptPreview: previewText(prompt),
                error: error instanceof Error ? error.message : String(error),
            });
        }
        throw error;
    }
}

async function transcribeWithWinky(
    buffer: ArrayBuffer,
    mime: string,
    settings: AppSettings
): Promise<string> {
    const accessToken = ensureAccessToken();
    const url = `${getAuthApiBaseUrl()}/ai/transcribe/`;
    const fileName = getAudioFileNameByMime(mime);
    const blob = new Blob([buffer], {type: mime || 'audio/webm'});
    const formData = new FormData();
    formData.append('file', blob, fileName);

    logRequest('transcribe:winky', 'start', {
        model: settings.transcriptionModel || 'winky-transcribe',
        mime,
        fileName,
        bufferSize: buffer.byteLength,
    });

    const response = await fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
            body: formData,
        },
        settings.apiSttTimeoutMs
    );

    if (!response.ok) {
        const data = await response.json().catch(async () => ({text: await response.text()}));
        if (response.status === 402) {
            throw createCreditsError(
                typeof data === 'string'
                    ? data
                    : data?.error?.message || data?.detail || data?.message
            );
        }
        const message = typeof data === 'string'
            ? data
            : data?.error?.message || data?.detail || data?.message || `Winky transcription failed (${response.status})`;
        throw new Error(message);
    }

    const data = await response.json().catch(async () => ({text: await response.text()}));
    const text = extractSpeechText(data)?.trim();
    if (!text) {
        throw new Error('Winky returned empty transcription.');
    }

    logRequest('transcribe:winky', 'ok', {
        textPreview: previewText(text),
    });
    return text;
}

const buildGeminiBody = (
    prompt: string,
    settings: AppSettings,
    history?: ChatHistoryMessage[]
): any => {
    const normalizedHistory = normalizeChatHistory(history);
    const contents = normalizedHistory.map((item) => ({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: [{text: item.content}],
    }));
    contents.push({
        role: 'user',
        parts: [{text: prompt || ''}],
    });

    const body: any = {
        contents,
    };
    if (settings.llmPrompt?.trim()) {
        body.systemInstruction = {
            role: 'system',
            parts: [{text: settings.llmPrompt.trim()}],
        };
    }
    return body;
};

async function chatWithGemini(
    prompt: string,
    settings: AppSettings,
    model?: string,
    history?: ChatHistoryMessage[],
    signal?: AbortSignal
): Promise<string> {
    const accessToken = ensureGoogleKey(settings);
    const resolvedModel = model || settings.llmModel || settings.apiLlmModel || GEMINI_LLM_MODELS[0] || 'gemini-3.0-pro';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent?key=${accessToken}`;
    logRequest('llm:gemini', 'start', {model: resolvedModel, promptPreview: previewText(prompt)});
    const body = buildGeminiBody(prompt, settings, history);
    let logged = false;
    try {
        const response = await fetchWithTimeout(
            url,
            {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body),
                signal,
            },
            settings.apiLlmTimeoutMs
        );
        const data = await response.json().catch(async () => ({text: await response.text()}));
        if (!response.ok) {
            logRequest('llm:gemini', 'error', {status: response.status, data});
            logged = true;
            const message = typeof data === 'string'
                ? data
                : data?.error?.message || 'Gemini request failed';
            throw new Error(message);
        }
        const candidates = (data as any)?.candidates;
        let content = '';
        if (Array.isArray(candidates) && candidates.length) {
            const parts = candidates[0]?.content?.parts;
            if (Array.isArray(parts)) {
                content = parts
                    .map((part: any) => part?.text ?? '')
                    .filter(Boolean)
                    .join('\n')
                    .trim();
            }
        }
        const fallback = extractSpeechText(data);
        if (!content && fallback) {
            content = fallback;
        }
        logRequest('llm:gemini', 'ok', {
            model: resolvedModel,
            status: response.status,
            promptPreview: previewText(prompt),
            responsePreview: previewText(content),
        });
        if (content) return content;
        throw new Error('Gemini returned an empty response.');
    } catch (error) {
        const aborted = signal?.aborted || (error instanceof DOMException && error.name === 'AbortError');
        if (!aborted && !logged) {
            logRequest('llm:gemini', 'error', {
                model: resolvedModel,
                promptPreview: previewText(prompt),
                error: error instanceof Error ? error.message : String(error),
            });
        }
        throw error;
    }
}

async function chatWithOllama(
    prompt: string,
    settings: AppSettings,
    model?: string,
    history?: ChatHistoryMessage[],
    signal?: AbortSignal
): Promise<string> {
    const resolvedModel = model || settings.localLlmModel || DEFAULT_LOCAL_LLM;
    const systemPrompt = (settings.llmPrompt || '').trim();
    const normalizedHistory = normalizeChatHistory(history);
    const messages = [
        ...(systemPrompt ? [{role: 'system', content: systemPrompt}] : []),
        ...normalizedHistory.map((item) => ({role: item.role, content: item.content})),
        {role: 'user', content: prompt},
    ];
    logRequest('llm:ollama', 'start', {model: resolvedModel, promptPreview: previewText(prompt)});
    let logged = false;
    try {
        const response = await ollamaAxios.post('/v1/chat/completions', {
            model: resolvedModel,
            messages,
        }, {
            timeout: Math.max(settings.apiLlmTimeoutMs || 0, 600_000),
            signal,
        });
        const data = response.data;
        const message = (data as any)?.message?.content;
        let content;
        if (Array.isArray(message)) {
            content = message.map((item: any) => item?.text ?? item?.content ?? '').join('\n').trim();
        } else if (typeof message === 'string') {
            content = message.trim();
        } else {
            const text = (data as any)?.choices?.[0]?.message?.content;
            if (typeof text === 'string') {
                content = text.trim();
            } else {
                content = extractSpeechText(data);
            }
        }
        logRequest('llm:ollama', 'ok', {
            model: resolvedModel,
            status: response.status,
            promptPreview: previewText(prompt),
            responsePreview: previewText(content),
        });
        return content;
    } catch (error: any) {
        const aborted = signal?.aborted || (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED');
        if (!aborted && !logged) {
            const errorData = error?.response?.data || error?.response || {};
            logRequest('llm:ollama', 'error', {
                model: resolvedModel,
                status: error?.response?.status,
                data: errorData,
                promptPreview: previewText(prompt),
                error: error instanceof Error ? error.message : String(error),
            });
            logged = true;
        }
        if (aborted) {
            throw error;
        }
        const message = typeof error?.response?.data === 'string'
            ? error.response.data
            : error?.response?.data?.error?.message || error?.message || 'Local LLM request failed';
        throw new Error(message);
    }
}

type WinkyWsEvent =
    | { event: 'start'; chat_id?: string; user_message_id?: string; model_level?: string }
    | { event: 'delta'; text?: string; chat_id?: string; message_id?: string; model_level?: string }
    | { event: 'done'; chat_id?: string; message_id?: string; model_level?: string; credits?: string }
    | { event: 'cancelled' }
    | { event: 'error'; code?: string; message?: string };

async function runWinkyLLMStream(
    prompt: string,
    settings: AppSettings,
    model: string,
    onChunk: (chunk: string) => void,
    controller?: AbortController
): Promise<string> {
    const accessToken = ensureAccessToken();
    const wsUrl = `${getWsBaseUrl()}/ws/ai/llm/?token=${encodeURIComponent(accessToken)}`;
    const modelLevel = mapWinkyModelToLevel(model);
    const timeoutMs = Math.max(settings.apiLlmTimeoutMs || 0, 10_000);

    return new Promise<string>((resolve, reject) => {
        let full = '';
        let settled = false;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const ws = new WebSocket(wsUrl);

        const cleanup = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            try {
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                    ws.close();
                }
            } catch {
            }
        };

        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        const done = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(full);
        };

        timeoutId = setTimeout(() => {
            fail(new Error('Winky LLM request timed out.'));
        }, timeoutMs);

        const onAbort = () => {
            try {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({action: 'cancel'}));
                }
            } catch {
            }
            const abortError = new DOMException('Aborted', 'AbortError');
            fail(abortError as unknown as Error);
        };

        if (controller) {
            if (controller.signal.aborted) {
                onAbort();
                return;
            }
            controller.signal.addEventListener('abort', onAbort, {once: true});
        }

        ws.onopen = () => {
            try {
                ws.send(JSON.stringify({
                    action: 'generate',
                    prompt,
                    model_level: modelLevel,
                }));
            } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(String(event.data || '{}')) as WinkyWsEvent;
                if (!data || typeof data !== 'object') return;

                if (data.event === 'delta') {
                    const chunk = data.text || '';
                    if (!chunk) return;
                    full += chunk;
                    onChunk(chunk);
                    return;
                }

                if (data.event === 'done') {
                    done();
                    return;
                }

                if (data.event === 'cancelled') {
                    fail(new DOMException('Cancelled', 'AbortError') as unknown as Error);
                    return;
                }

                if (data.event === 'error') {
                    const code = data.code || '';
                    if (code === 'not_enough_credits' || code === '402') {
                        fail(createCreditsError(data.message));
                        return;
                    }
                    const error = new Error(data.message || 'Winky streaming request failed.');
                    (error as any).code = code;
                    fail(error);
                    return;
                }
            } catch {
            }
        };

        ws.onerror = () => {
            fail(new Error('Winky streaming connection error.'));
        };

        ws.onclose = (event) => {
            if (settled) return;
            if (controller?.signal.aborted) {
                fail(new DOMException('Aborted', 'AbortError') as unknown as Error);
                return;
            }
            if (event.code === 1000) {
                done();
                return;
            }
            fail(new Error(event.reason || `Winky socket closed (${event.code})`));
        };
    });
}

async function chatWithWinky(
    prompt: string,
    settings: AppSettings,
    model: string,
    history?: ChatHistoryMessage[],
    controller?: AbortController
): Promise<string> {
    const fullPrompt = buildWinkyPrompt(prompt, settings, history);
    logRequest('llm:winky', 'start', {
        model,
        promptPreview: previewText(fullPrompt),
    });
    const full = await runWinkyLLMStream(fullPrompt, settings, model, () => {
    }, controller);
    if (!full.trim()) {
        throw new Error('Winky returned an empty response.');
    }
    logRequest('llm:winky', 'ok', {
        model,
        promptPreview: previewText(fullPrompt),
        responsePreview: previewText(full),
    });
    return full;
}

async function streamGeminiChatCompletion(
    prompt: string,
    requestId: string,
    settings: AppSettings,
    model: string,
    history: ChatHistoryMessage[] | undefined,
    controller: AbortController
): Promise<void> {
    const accessToken = ensureGoogleKey(settings);
    const resolvedModel = model || settings.llmModel || settings.apiLlmModel || GEMINI_LLM_MODELS[0] || 'gemini-3.0-pro';
    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:streamGenerateContent?alt=sse&key=${accessToken}`;
    const body = buildGeminiBody(prompt, settings, history);

    const response = await fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
            signal: controller.signal,
        },
        settings.apiLlmTimeoutMs
    );
    if (!response.ok) {
        const data = await response.json().catch(async () => ({text: await response.text()}));
        const message = typeof data === 'string'
            ? data
            : data?.error?.message || `Gemini streaming failed (status: ${response.status})`;
        throw new Error(message);
    }

    if (!response.body) {
        throw new Error('Gemini streaming failed: No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';

    const flushBuffer = () => {
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line === 'data: [DONE]' || line === '[DONE]' || line.startsWith('event:')) continue;
            const jsonLine = line.startsWith('data:') ? line.slice(5).trim() : line;
            if (!jsonLine) continue;
            try {
                const json = JSON.parse(jsonLine);
                const chunk = extractGeminiChunkText(json);
                const next = appendStreamingDelta(full, chunk);
                full = next.full;
                if (next.delta) {
                    emit('delta', {requestId, delta: next.delta});
                }
            } catch (error) {
                console.warn('[assistantBridge] failed to parse gemini chunk', error, jsonLine);
            }
        }
    };

    while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        flushBuffer();
    }
    buffer += decoder.decode();
    flushBuffer();

    if (!full.trim()) {
        throw new Error('Gemini returned an empty response.');
    }

    emit('done', {requestId, full});
    logRequest('llm:stream', 'ok', {
        requestId,
        host: 'api',
        model: resolvedModel,
        streaming: true,
        promptPreview: previewText(prompt),
        responsePreview: previewText(full),
    });
}

async function streamOllamaChatCompletion(
    prompt: string,
    requestId: string,
    settings: AppSettings,
    history: ChatHistoryMessage[] | undefined,
    controller: AbortController
): Promise<void> {
    const model = settings.localLlmModel || settings.llmModel || DEFAULT_LOCAL_LLM;
    const systemPrompt = (settings.llmPrompt || '').trim();
    const normalizedHistory = normalizeChatHistory(history);
    const messages = [
        ...(systemPrompt ? [{role: 'system', content: systemPrompt}] : []),
        ...normalizedHistory.map((item) => ({role: item.role, content: item.content})),
        {role: 'user', content: prompt},
    ];
    logRequest('llm:ollama:stream', 'start', {requestId, model, promptPreview: previewText(prompt)});

    const response = await fetchWithTimeout(
        'http://localhost:11434/v1/chat/completions',
        {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({model, messages, stream: true}),
            signal: controller.signal,
        },
        Math.max(settings.apiLlmTimeoutMs || 0, 600_000)
    );
    if (!response.ok) {
        logRequest('llm:ollama:stream', 'error', {requestId, status: response.status});
        const text = await response.text().catch(() => '');
        throw new Error(text || `Local LLM streaming failed (status: ${response.status})`);
    }

    if (!response.body) {
        logRequest('llm:ollama:stream', 'error', {requestId, status: response.status, error: 'No response body'});
        throw new Error('Local LLM streaming failed: No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';

    const flushBuffer = () => {
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
            const line = part.trim();
            if (!line || line === 'data: [DONE]' || line === '[DONE]') continue;
            const jsonLine = line.startsWith('data:') ? line.slice(5).trim() : line;
            if (!jsonLine) continue;
            try {
                const json = JSON.parse(jsonLine);
                const deltaRaw =
                    json?.choices?.[0]?.delta?.content ??
                    json?.message?.content ??
                    json?.response;
                const text = coerceStreamText(deltaRaw);
                if (!text) continue;
                full += text;
                emit('delta', {requestId, delta: text});
            } catch (error) {
                console.warn('[assistantBridge] failed to parse ollama chunk', error, jsonLine);
            }
        }
    };

    while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        flushBuffer();
    }
    buffer += decoder.decode();
    flushBuffer();
    emit('done', {requestId, full});
    logRequest('llm:ollama:stream', 'ok', {
        requestId,
        model,
        streaming: true,
        promptPreview: previewText(prompt),
        responsePreview: previewText(full),
    });
}

async function streamChatCompletion(
    prompt: string,
    requestId: string,
    settings: AppSettings,
    history: ChatHistoryMessage[] | undefined,
    controller: AbortController
): Promise<void> {
    const {host, model} = resolveLlmTarget(settings);

    logRequest('llm:stream', 'start', {
        requestId,
        host,
        model,
        promptPreview: previewText(prompt),
    });

    if (host === 'local') {
        await streamOllamaChatCompletion(prompt, requestId, settings, history, controller);
        return;
    }

    if (WINKY_LLM_SET.has(model)) {
        const fullPrompt = buildWinkyPrompt(prompt, settings, history);
        const full = await runWinkyLLMStream(
            fullPrompt,
            settings,
            model,
            (chunk) => emit('delta', {requestId, delta: chunk}),
            controller
        );
        emit('done', {requestId, full});
        logRequest('llm:stream', 'ok', {
            requestId,
            host,
            model,
            streaming: true,
            provider: 'winky',
            promptPreview: previewText(fullPrompt),
            responsePreview: previewText(full),
        });
        return;
    }

    if (GEMINI_LLM_SET.has(model)) {
        try {
            await streamGeminiChatCompletion(prompt, requestId, settings, model, history, controller);
        } catch (error) {
            if (controller.signal.aborted) {
                throw error;
            }
            const full = await chatWithGemini(prompt, settings, model, history, controller.signal);
            emit('delta', {requestId, delta: full});
            emit('done', {requestId, full});
            logRequest('llm:stream', 'ok', {
                requestId,
                host,
                model,
                streaming: false,
                fallback: 'gemini-non-stream',
                promptPreview: previewText(prompt),
                responsePreview: previewText(full),
            });
        }
        return;
    }

    const apiKey = ensureOpenAiKey(settings);
    const url = `${OPENAI_BASE}/v1/chat/completions`;
    const systemPrompt = (settings.llmPrompt || '').trim();
    const normalizedHistory = normalizeChatHistory(history);
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
        messages.push({role: 'system', content: systemPrompt});
    }
    for (const item of normalizedHistory) {
        messages.push({role: item.role, content: item.content});
    }
    messages.push({role: 'user', content: prompt});

    const body: any = {
        model,
        stream: true,
        messages,
    };
    if (supportsCustomTemperature(model)) {
        body.temperature = 0.3;
    }
    const response = await fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        },
        settings.apiLlmTimeoutMs
    );
    if (!response.ok || !response.body) {
        logRequest('llm:stream', 'error', {requestId, status: response.status});
        const text = await response.text();
        throw new Error(text || 'Streaming request failed');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';

    const flushBuffer = () => {
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
            const lines = part.split('\n');
            for (const rawLine of lines) {
                const trimmed = rawLine.trim();
                if (!trimmed || trimmed === 'data: [DONE]' || trimmed === '[DONE]' || trimmed.startsWith('event:')) {
                    continue;
                }
                if (!trimmed.startsWith('data:')) continue;

                const line = trimmed.slice(5).trim();
                if (!line || line === '[DONE]') continue;
                try {
                    const json = JSON.parse(line);
                    const text = extractOpenAiDelta(json);
                    if (!text) continue;
                    full += text;
                    emit('delta', {requestId, delta: text});
                } catch (error) {
                    console.warn('[assistantBridge] failed to parse chunk', error, line);
                }
            }
        }
    };

    while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        flushBuffer();
    }
    buffer += decoder.decode();
    flushBuffer();
    emit('done', {requestId, full});
    logRequest('llm:stream', 'ok', {
        requestId,
        host,
        model,
        streaming: true,
        promptPreview: previewText(prompt),
        responsePreview: previewText(full),
    });
}

type TranscriptionModeValue = 'api' | 'local';

type TranscriptionRunOptions = {
    settings: AppSettings;
    buffer: ArrayBuffer;
    mime: string;
    filename: string;
    stream?: boolean;
};

type TranscriptionRunResult = {
    text: string;
    mode: TranscriptionModeValue;
    model: string;
};

const buildTranscriptionLogContext = (
    mode: TranscriptionModeValue,
    model: string,
    mime: string,
    stream: boolean
) => (stream ? {mode, model, mime, stream: true} : {mode, model, mime});

const resolveTranscriptionTarget = (settings: AppSettings): { mode: TranscriptionModeValue; model: string } => {
    const mode: TranscriptionModeValue = settings.transcriptionMode === 'local' ? 'local' : 'api';
    const model =
        mode === 'local'
            ? settings.localWhisperModel || DEFAULT_LOCAL_TRANSCRIBE
            : settings.transcriptionModel || DEFAULT_API_TRANSCRIBE;
    return {mode, model};
};

async function transcribeAudioBuffer({
                                         settings,
                                         buffer,
                                         mime,
                                         filename,
                                         stream = false,
                                     }: TranscriptionRunOptions): Promise<TranscriptionRunResult> {
    const {mode: transcriptionMode, model: transcriptionModel} = resolveTranscriptionTarget(settings);

    const logPayload = buildTranscriptionLogContext(transcriptionMode, transcriptionModel, mime, stream);
    logRequest('transcribe', 'start', logPayload);

    const text = await (async () => {
        if (transcriptionMode === 'local') {
            return transcribeWithLocal(buffer, mime, filename, settings);
        }
        if (WINKY_TRANSCRIBE_SET.has(transcriptionModel)) {
            return transcribeWithWinky(buffer, mime, settings);
        }
        if (GOOGLE_TRANSCRIBE_SET.has(transcriptionModel)) {
            return transcribeWithGoogle(buffer, mime, settings, transcriptionModel);
        }
        return transcribeWithOpenAi(buffer, mime, filename, settings, transcriptionModel);
    })();

    logRequest('transcribe', 'ok', {
        ...logPayload,
        textPreview: previewText(text),
    });

    return {text, mode: transcriptionMode, model: transcriptionModel};
}

export async function assistantProcessAudio(args: ProcessAudioArgs): Promise<AssistantResponse> {
    const settings = await loadSettings();
    const buffer = args.arrayBuffer;
    if (buffer.byteLength === 0) {
        return {ok: false, error: 'Empty audio'};
    }
    const {text, mode: transcriptionMode, model: transcriptionModel} = await transcribeAudioBuffer({
        settings,
        buffer,
        mime: args.mime,
        filename: args.filename || 'lastN.webm',
    });

    const {host: llmHost, model: llmModel} = resolveLlmTarget(settings);
    logRequest('llm:select', 'start', {
        host: llmHost,
        model: llmModel,
        rawHost: settings.llmHost,
        rawApiModel: settings.apiLlmModel,
        rawLocalModel: settings.localLlmModel,
        rawLlmModel: settings.llmModel,
    });
    let answer = '';
    if (text) {
        if (llmHost === 'local') {
            answer = await chatWithOllama(text, settings, llmModel);
        } else if (WINKY_LLM_SET.has(llmModel)) {
            answer = await chatWithWinky(text, settings, llmModel);
        } else if (GEMINI_LLM_SET.has(llmModel)) {
            answer = await chatWithGemini(text, settings, llmModel);
        } else {
            answer = await chatCompletion(text, settings, llmModel);
        }
    }
    logRequest('transcribe+llm', 'ok', {
        mode: transcriptionMode,
        model: transcriptionModel,
        llmHost,
        llmModel,
        textPreview: previewText(text),
        answerPreview: previewText(answer),
    });
    return {ok: true, text, answer};
}

export async function assistantTranscribeOnly(args: ProcessAudioArgs): Promise<{ ok: true; text: string } | {
    ok: false;
    error: string
}> {
    const settings = await loadSettings();
    const buffer = args.arrayBuffer;
    if (buffer.byteLength === 0) {
        return {ok: false, error: 'Empty audio'};
    }
    const {text} = await transcribeAudioBuffer({
        settings,
        buffer,
        mime: args.mime,
        filename: args.filename || 'lastN.webm',
    });
    return {ok: true, text};
}

export async function assistantProcessAudioStream(args: ProcessAudioArgs): Promise<AssistantResponse> {
    const settings = await loadSettings();
    const buffer = args.arrayBuffer;
    if (buffer.byteLength === 0) {
        return {ok: false, error: 'Empty audio'};
    }
    const requestId = args.requestId || crypto.randomUUID();
    emit('transcript', {requestId, delta: ''});
    const {text} = await transcribeAudioBuffer({
        settings,
        buffer,
        mime: args.mime,
        filename: args.filename || 'lastN.webm',
        stream: true,
    });
    emit('transcript', {requestId, delta: text});
    const {host: llmHost, model: llmModel} = resolveLlmTarget(settings);
    logRequest('llm:stream', 'start', {
        requestId,
        host: llmHost,
        model: llmModel,
        rawHost: settings.llmHost,
        rawApiModel: settings.apiLlmModel,
        rawLocalModel: settings.localLlmModel,
        rawLlmModel: settings.llmModel,
        promptPreview: previewText(text),
    });

    runWithActiveStream(requestId, (controller) =>
        streamChatCompletion(text, requestId, settings, undefined, controller)
    );
    return {ok: true, text, answer: ''};
}

export async function assistantAskChat(args: AskChatRequest) {
    const settings = await loadSettings();
    const requestId = args.requestId || crypto.randomUUID();
    const history = normalizeChatHistory(args.history);
    runWithActiveStream(requestId, (controller) =>
        streamChatCompletion(args.text, requestId, settings, history, controller)
    );
}

export async function assistantStopStream(args: StopStreamRequest): Promise<void> {
    const requestId = args.requestId || 'default';
    const controller = activeStreams.get(requestId);
    if (controller) {
        controller.abort();
        activeStreams.delete(requestId);
    }
}

export function assistantOnStreamTranscript(cb: StreamListener<{ requestId?: string; delta: string }>) {
    addStreamListener('transcript', cb);
}

export function assistantOnStreamDelta(cb: StreamListener<{ requestId?: string; delta: string }>) {
    addStreamListener('delta', cb);
}

export function assistantOnStreamDone(cb: StreamListener<{ requestId?: string; full: string }>) {
    addStreamListener('done', cb);
}

export function assistantOnStreamError(cb: StreamListener<{ requestId?: string; error: string }>) {
    addStreamListener('error', cb);
}

export function assistantOffStreamTranscript(cb?: StreamListener<{ requestId?: string; delta: string }>) {
    removeStreamListener('transcript', cb);
}

export function assistantOffStreamDelta(cb?: StreamListener<{ requestId?: string; delta: string }>) {
    removeStreamListener('delta', cb);
}

export function assistantOffStreamDone(cb?: StreamListener<{ requestId?: string; full: string }>) {
    removeStreamListener('done', cb);
}

export function assistantOffStreamError(cb?: StreamListener<{ requestId?: string; error: string }>) {
    removeStreamListener('error', cb);
}

type ScreenPrompts = {
    systemPrompt: string;
    userPrompt: string;
};

const buildScreenPrompts = (settings: AppSettings): ScreenPrompts => {
    const prompt = (settings.screenProcessingPrompt || '').trim();
    const systemPrompt = prompt || 'You are an assistant that analyses screenshots.';
    const userPrompt = 'Analyze the provided screenshot and provide actionable insights.';
    return {systemPrompt, userPrompt};
};

const normalizeBase64Image = (value: string): string => {
    if (!value) return '';
    const commaIndex = value.indexOf(',');
    if (commaIndex >= 0) {
        return value.slice(commaIndex + 1);
    }
    return value;
};

async function processScreenWithOpenAi(
    payload: ScreenProcessRequest,
    settings: AppSettings,
    prompts: ScreenPrompts,
    history: ChatHistoryMessage[]
): Promise<{ answer: string; model: string }> {
    const apiKey = ensureOpenAiKey(settings);
    const url = `${OPENAI_BASE}/v1/chat/completions`;
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [];

    if (prompts.systemPrompt) {
        messages.push({
            role: 'system',
            content: prompts.systemPrompt,
        });
    }

    for (const item of history) {
        messages.push({
            role: item.role,
            content: item.content,
        });
    }

    messages.push({
        role: 'user',
        content: [
            {type: 'text', text: prompts.userPrompt},
            {
                type: 'image_url',
                image_url: {
                    url: `data:${payload.mime || 'image/png'};base64,${payload.imageBase64}`,
                },
            },
        ],
    });

    const response = await fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: SCREEN_OPENAI_MODEL,
                temperature: 0.2,
                messages,
            }),
        },
        settings.screenProcessingTimeoutMs
    );
    const data = await response.json().catch(async () => ({text: await response.text()}));
    if (!response.ok) {
        const message = typeof data === 'string'
            ? data
            : data?.error?.message || 'Screen processing failed';
        throw new Error(message);
    }
    const answer = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(answer)
        ? answer.map((entry: any) => entry?.text || entry?.content || '').join('')
        : answer;
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) {
        throw new Error('Empty response from OpenAI screen analysis.');
    }
    return {answer: normalized, model: SCREEN_OPENAI_MODEL};
}

async function processScreenWithGemini(
    payload: ScreenProcessRequest,
    settings: AppSettings,
    prompts: ScreenPrompts,
    history: ChatHistoryMessage[]
): Promise<{ answer: string; model: string }> {
    const accessToken = ensureGoogleKey(settings);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${SCREEN_GEMINI_MODEL}:generateContent?key=${accessToken}`;
    const contents: any[] = history.map((item) => ({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: [{text: item.content}],
    }));
    contents.push({
        role: 'user',
        parts: [
            {text: prompts.userPrompt},
            {
                inline_data: {
                    mime_type: payload.mime || 'image/png',
                    data: payload.imageBase64,
                },
            },
        ],
    });

    const body: any = {
        contents,
        generationConfig: {temperature: 0.2},
    };
    if (prompts.systemPrompt) {
        body.systemInstruction = {
            role: 'system',
            parts: [{text: prompts.systemPrompt}],
        };
    }
    const response = await fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        },
        settings.screenProcessingTimeoutMs
    );
    const data = await response.json().catch(async () => ({text: await response.text()}));
    if (!response.ok) {
        const message = typeof data === 'string'
            ? data
            : data?.error?.message || 'Screen processing failed';
        throw new Error(message);
    }
    let text = '';
    const candidates = (data as any)?.candidates;
    if (Array.isArray(candidates) && candidates.length) {
        const parts = candidates[0]?.content?.parts;
        if (Array.isArray(parts)) {
            text = parts
                .map((part: any) => part?.text || '')
                .filter(Boolean)
                .join('\n')
                .trim();
        }
    }
    if (!text) {
        const fallback = extractSpeechText(data);
        if (fallback) {
            text = fallback.trim();
        }
    }
    if (!text) {
        throw new Error('Empty response from Google screen analysis.');
    }
    return {answer: text, model: SCREEN_GEMINI_MODEL};
}

export async function processScreenImage(
    payload: ScreenProcessRequest
): Promise<ScreenProcessResponse> {
    const settings = await loadSettings();
    const userText = (payload.userText || '').trim();
    const prompts = buildScreenPrompts(settings);
    const provider = settings.screenProcessingModel === 'google' ? 'google' : 'openai';
    const history = normalizeChatHistory(payload.history);
    const effectiveUserPrompt = userText
        ? `${prompts.userPrompt}\n\nUser request: ${userText}`
        : prompts.userPrompt;
    const normalizedPayload: ScreenProcessRequest = {
        ...payload,
        imageBase64: normalizeBase64Image(payload.imageBase64),
    };

    logRequest('screen', 'start', {
        provider,
        model: provider === 'google' ? SCREEN_GEMINI_MODEL : SCREEN_OPENAI_MODEL,
        mime: payload.mime,
        width: payload.width,
        height: payload.height,
        historySize: history.length,
        hasUserText: !!userText,
        promptPreview: previewText(effectiveUserPrompt),
    });

    try {
        const promptsWithUserText: ScreenPrompts = {
            systemPrompt: prompts.systemPrompt,
            userPrompt: effectiveUserPrompt,
        };
        const {answer, model} = provider === 'google'
            ? await processScreenWithGemini(normalizedPayload, settings, promptsWithUserText, history)
            : await processScreenWithOpenAi(normalizedPayload, settings, promptsWithUserText, history);

        logRequest('screen', 'ok', {
            provider,
            model,
            responsePreview: previewText(answer),
        });

        return {
            ok: true,
            answer,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logRequest('screen', 'error', {
            provider,
            mime: payload.mime,
            error: message,
        });
        return {
            ok: false,
            error: message,
        };
    }
}

