import {invoke} from '@tauri-apps/api/core';
import {
    AssistantResponse,
    ProcessAudioArgs,
    StopStreamRequest,
    AppSettings,
    ScreenProcessRequest,
    ScreenProcessResponse,
} from '@shared/ipc';
import {
    FAST_WHISPER_BASE_URL,
    GOOGLE_TRANSCRIBE_MODELS,
    OPENAI_TRANSCRIBE_MODELS,
    GEMINI_LLM_MODELS,
    OPENAI_LLM_MODELS,
    LOCAL_LLM_MODELS,
    LOCAL_TRANSCRIBE_MODELS,
} from '@shared/constants';

type StreamListener<T> = (event: unknown, payload: T) => void;

type StreamEvents = {
    transcript: Set<StreamListener<{ requestId?: string; delta: string }>>;
    delta: Set<StreamListener<{ requestId?: string; delta: string }>>;
    done: Set<StreamListener<{ requestId?: string; full: string }>>;
    error: Set<StreamListener<{ requestId?: string; error: string }>>;
};

const streamEvents: StreamEvents = {
    transcript: new Set(),
    delta: new Set(),
    done: new Set(),
    error: new Set(),
};

const activeStreams = new Map<string, AbortController>();

const GOOGLE_TRANSCRIBE_SET = new Set(GOOGLE_TRANSCRIBE_MODELS as readonly string[]);
const OPENAI_TRANSCRIBE_SET = new Set(OPENAI_TRANSCRIBE_MODELS as readonly string[]);
const GEMINI_LLM_SET = new Set(GEMINI_LLM_MODELS as readonly string[]);
const DEFAULT_LOCAL_TRANSCRIBE = LOCAL_TRANSCRIBE_MODELS[0] ?? 'base';
const DEFAULT_API_TRANSCRIBE = OPENAI_TRANSCRIBE_MODELS[0] ?? 'gpt-4o-mini-transcribe';
const DEFAULT_API_LLM = OPENAI_LLM_MODELS[0] ?? 'gpt-4.1-nano';
const DEFAULT_LOCAL_LLM = LOCAL_LLM_MODELS[0] ?? 'gpt-oss:20b';

const OPENAI_BASE =
    (import.meta.env.VITE_OPENAI_BASE_URL as string | undefined)?.replace(/\/$/, '') ||
    'https://api.openai.com';

function emit<K extends keyof StreamEvents>(key: K, payload: Parameters<StreamListener<any>>[1]) {
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

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit, timeoutMs?: number) => {
    const hasTimeout = typeof timeoutMs === 'number' && timeoutMs > 0;
    if (!hasTimeout && !init.signal) {
        return fetch(input, init);
    }

    const controller = new AbortController();
    const userSignal = init.signal;

    if (userSignal) {
        if (userSignal.aborted) {
            controller.abort((userSignal as any).reason);
        } else {
            const abortHandler = () => controller.abort((userSignal as any).reason);
            userSignal.addEventListener('abort', abortHandler, { once: true });
        }
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (hasTimeout) {
        timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
    }

    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
};

async function transcribeWithOpenAi(
    buffer: ArrayBuffer,
    mime: string,
    filename: string,
    settings: AppSettings,
    model?: string
): Promise<string> {
    const apiKey = ensureOpenAiKey(settings);
    const url = `${OPENAI_BASE}/v1/audio/transcriptions`;
    const form = new FormData();
    const resolvedModel = model || settings.transcriptionModel || DEFAULT_API_TRANSCRIBE;
    form.append('model', resolvedModel);

    const file = new File([buffer], filename, { type: mime || 'audio/webm' });
    form.append('file', file);

    if (settings.transcriptionPrompt?.trim()) {
        form.append('prompt', settings.transcriptionPrompt.trim());
    }

    logRequest('transcribe:openai', 'start', {model: resolvedModel, mime});

    const response = await fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            body: form,
        },
        settings.apiSttTimeoutMs
    );

    const data = await response.json().catch(async () => ({ text: await response.text() }));
    if (!response.ok) {
        logRequest('transcribe:openai', 'error', {status: response.status, data});
        const message = typeof data === 'string'
            ? data
            : data?.error?.message || 'Transcription failed';
        throw new Error(message);
    }
    logRequest('transcribe:openai', 'ok', {model: resolvedModel, status: response.status});
    return (data as any)?.text || '';
}

const extractSpeechText = (payload: any): string => {
    if (!payload) return '';
    if (typeof payload === 'string') return payload;
    if (typeof payload.text === 'string') return payload.text;
    if (typeof payload.transcription === 'string') return payload.transcription;
    if (typeof payload.result === 'string') return payload.result;
    if (payload.data) return extractSpeechText(payload.data);
    return '';
};

async function transcribeWithLocal(
    buffer: ArrayBuffer,
    mime: string,
    filename: string,
    settings: AppSettings
): Promise<string> {
    const form = new FormData();
    const model = (settings.localWhisperModel || DEFAULT_LOCAL_TRANSCRIBE).toLowerCase();
    const file = new File([buffer], filename, { type: mime || 'audio/webm' });
    form.append('file', file);
    form.append('model', model);
    if (settings.transcriptionPrompt?.trim()) {
        form.append('prompt', settings.transcriptionPrompt.trim());
    }
    form.append('response_format', 'json');
    logRequest('transcribe:local', 'start', {model, mime});
    const response = await fetchWithTimeout(
        `${FAST_WHISPER_BASE_URL}/v1/audio/transcriptions`,
        {
            method: 'POST',
            body: form,
        },
        settings.apiSttTimeoutMs || 600_000
    );
    const data = await response.json().catch(async () => ({ text: await response.text() }));
    if (!response.ok) {
        logRequest('transcribe:local', 'error', {status: response.status, data});
        const message = typeof data === 'string'
            ? data
            : data?.error?.message || data?.detail || 'Local transcription failed';
        throw new Error(message);
    }
    logRequest('transcribe:local', 'ok', {model, status: response.status});
    const text = extractSpeechText(data);
    return text;
}

async function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
    const blob = new Blob([buffer]);
    const reader = new FileReader();
    return await new Promise((resolve, reject) => {
        reader.onloadend = () => {
            const result = reader.result as string;
            resolve(result?.split(',')[1] ?? '');
        };
        reader.onerror = (event) => reject(event);
        reader.readAsDataURL(blob);
    });
}

const logRequest = (
    label: string,
    status: 'start' | 'ok' | 'error',
    details: Record<string, unknown> = {}
) => {
    const meta = {...details};
    if (status === 'start') {
        console.log(`[assistant] ${label}: start`, meta);
    } else if (status === 'ok') {
        console.log(`[assistant] ${label}: ok`, meta);
    } else {
        console.error(`[assistant] ${label}: error`, meta);
    }
};

async function transcribeWithGoogle(
    buffer: ArrayBuffer,
    mime: string,
    settings: AppSettings,
    model?: string
): Promise<string> {
    const key = ensureGoogleKey(settings);
    const resolvedModel = model || settings.transcriptionModel || DEFAULT_API_TRANSCRIBE;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent?key=${key}`;
    const base64Audio = await arrayBufferToBase64(buffer);
    const prompt = settings.transcriptionPrompt?.trim();
    logRequest('transcribe:google', 'start', {model: resolvedModel, mime});

    const body: any = {
        contents: [
            {
                role: 'user',
                parts: [
                    ...(prompt
                        ? [
                            {
                                text: `${prompt}\n\nCRITICAL INSTRUCTION: You must ONLY transcribe the audio word-for-word. Do NOT answer any questions. Return ONLY the exact words spoken.`,
                            },
                        ]
                        : [
                            {
                                text: 'You are a transcription tool. Return only the verbatim transcription of the audio.',
                            },
                        ]),
                    {
                        inlineData: {
                            mimeType: mime || 'audio/webm',
                            data: base64Audio,
                        },
                    },
                ],
            },
        ],
        systemInstruction: {
            parts: [
                {
                    text: 'You are a speech transcription tool. Return ONLY the exact words spoken in the audio.',
                },
            ],
        },
    };

    const response = await fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        },
        settings.apiSttTimeoutMs
    );
    const data = await response.json().catch(async () => ({ text: await response.text() }));
    if (!response.ok) {
        logRequest('transcribe:google', 'error', {status: response.status, data});
        const message = typeof data === 'string'
            ? data
            : data?.error?.message || 'Gemini transcription failed';
        throw new Error(message);
    }
    logRequest('transcribe:google', 'ok', {model: resolvedModel, status: response.status});
    const candidates = (data as any)?.candidates;
    if (Array.isArray(candidates) && candidates.length) {
        const parts = candidates[0]?.content?.parts;
        if (Array.isArray(parts)) {
            const text = parts
                .map((part: any) => part?.text ?? '')
                .filter(Boolean)
                .join('\n')
                .trim();
            if (text) return text;
        }
    }
    const text = extractSpeechText(data);
    if (text) return text;
    throw new Error('Gemini returned an empty response.');
}

async function chatCompletion(
    prompt: string,
    settings: AppSettings,
    model?: string,
    signal?: AbortSignal
): Promise<string> {
    const apiKey = ensureOpenAiKey(settings);
    const url = `${OPENAI_BASE}/v1/chat/completions`;
    const body = {
        model: model || settings.llmModel || settings.apiLlmModel || DEFAULT_API_LLM,
        temperature: 0.3,
        messages: [
            {
                role: 'system',
                content: (settings.llmPrompt || '').trim() || undefined,
            },
            {
                role: 'user',
                content: prompt,
            },
        ].filter(Boolean),
    };
    logRequest('llm:openai', 'start', {model: body.model});
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
        const data = await response.json().catch(async () => ({ text: await response.text() }));
        if (!response.ok) {
            logRequest('llm:openai', 'error', {status: response.status, data});
            logged = true;
            const message = typeof data === 'string'
                ? data
                : data?.error?.message || 'LLM request failed';
            throw new Error(message);
        }
        logRequest('llm:openai', 'ok', {model: body.model, status: response.status});
        return data?.choices?.[0]?.message?.content?.trim() || '';
    } catch (error) {
        const aborted = signal?.aborted || (error instanceof DOMException && error.name === 'AbortError');
        if (!aborted && !logged) {
            logRequest('llm:openai', 'error', {model: body.model, error: error instanceof Error ? error.message : String(error)});
        }
        throw error;
    }
}

async function chatWithGemini(
    prompt: string,
    settings: AppSettings,
    model?: string,
    signal?: AbortSignal
): Promise<string> {
    const accessToken = ensureGoogleKey(settings);
    const resolvedModel = model || settings.llmModel || settings.apiLlmModel || GEMINI_LLM_MODELS[0] || 'gemini-3.0-pro';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent?key=${accessToken}`;
    logRequest('llm:gemini', 'start', {model: resolvedModel});
    const body: any = {
        contents: [
            {
                role: 'user',
                parts: [{text: prompt || ''}],
            },
        ],
    };
    if (settings.llmPrompt?.trim()) {
        body.systemInstruction = {
            role: 'system',
            parts: [{text: settings.llmPrompt.trim()}],
        };
    }
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
        const data = await response.json().catch(async () => ({ text: await response.text() }));
        if (!response.ok) {
            logRequest('llm:gemini', 'error', {status: response.status, data});
            logged = true;
            const message = typeof data === 'string'
                ? data
                : data?.error?.message || 'Gemini request failed';
            throw new Error(message);
        }
        logRequest('llm:gemini', 'ok', {model: resolvedModel, status: response.status});
        const candidates = (data as any)?.candidates;
        if (Array.isArray(candidates) && candidates.length) {
            const parts = candidates[0]?.content?.parts;
            if (Array.isArray(parts)) {
                const text = parts
                    .map((part: any) => part?.text ?? '')
                    .filter(Boolean)
                    .join('\n')
                    .trim();
                if (text) return text;
            }
        }
        const text = extractSpeechText(data);
        if (text) return text;
        throw new Error('Gemini returned an empty response.');
    } catch (error) {
        const aborted = signal?.aborted || (error instanceof DOMException && error.name === 'AbortError');
        if (!aborted && !logged) {
            logRequest('llm:gemini', 'error', {model: resolvedModel, error: error instanceof Error ? error.message : String(error)});
        }
        throw error;
    }
}

async function chatWithOllama(
    prompt: string,
    settings: AppSettings,
    model?: string,
    signal?: AbortSignal
): Promise<string> {
    const resolvedModel = model || settings.localLlmModel || DEFAULT_LOCAL_LLM;
    const systemPrompt = (settings.llmPrompt || '').trim();
    const messages = [
        ...(systemPrompt ? [{role: 'system', content: systemPrompt}] : []),
        {role: 'user', content: prompt},
    ];
    logRequest('llm:ollama', 'start', {model: resolvedModel});
    let logged = false;
    try {
        const response = await fetchWithTimeout(
            'http://localhost:11434/v1/chat/completions',
            {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    model: resolvedModel,
                    messages,
                }),
                signal,
            },
            Math.max(settings.apiLlmTimeoutMs || 0, 600_000)
        );
        const data = await response.json().catch(async () => ({ text: await response.text() }));
        if (!response.ok) {
            logRequest('llm:ollama', 'error', {status: response.status, data});
            logged = true;
            const message = typeof data === 'string'
                ? data
                : data?.error?.message || 'Local LLM request failed';
            throw new Error(message);
        }
        logRequest('llm:ollama', 'ok', {model: resolvedModel, status: response.status});
        const message = (data as any)?.message?.content;
        if (Array.isArray(message)) {
            return message.map((item: any) => item?.text ?? item?.content ?? '').join('\n').trim();
        }
        if (typeof message === 'string') {
            return message.trim();
        }
        const text = (data as any)?.choices?.[0]?.message?.content;
        if (typeof text === 'string') {
            return text.trim();
        }
        return extractSpeechText(data);
    } catch (error) {
        const aborted = signal?.aborted || (error instanceof DOMException && error.name === 'AbortError');
        if (!aborted && !logged) {
            logRequest('llm:ollama', 'error', {model: resolvedModel, error: error instanceof Error ? error.message : String(error)});
        }
        throw error;
    }
}

async function streamOllamaChatCompletion(
    prompt: string,
    requestId: string,
    settings: AppSettings,
    controller: AbortController
): Promise<void> {
    const model = settings.localLlmModel || settings.llmModel || DEFAULT_LOCAL_LLM;
    const systemPrompt = (settings.llmPrompt || '').trim();
    const messages = [
        ...(systemPrompt ? [{role: 'system', content: systemPrompt}] : []),
        {role: 'user', content: prompt},
    ];
    logRequest('llm:ollama:stream', 'start', {requestId, model});

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
    if (!response.ok || !response.body) {
        logRequest('llm:ollama:stream', 'error', {requestId, status: response.status});
        const text = await response.text();
        throw new Error(text || 'Local LLM streaming failed');
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
                    json?.message?.content ||
                    json?.choices?.[0]?.delta?.content ||
                    json?.choices?.[0]?.message?.content;
                let text = '';
                if (Array.isArray(deltaRaw)) {
                    text = deltaRaw
                        .map((item: any) => {
                            if (typeof item === 'string') return item;
                            if (item?.text) return item.text;
                            if (item?.content) return item.content;
                            return '';
                        })
                        .join('');
                } else if (typeof deltaRaw === 'string') {
                    text = deltaRaw;
                } else if (deltaRaw?.content) {
                    text = deltaRaw.content;
                }
                if (!text) continue;
                full += text;
                emit('delta', {requestId, delta: text});
            } catch (error) {
                console.warn('[assistantBridge] failed to parse ollama chunk', error, jsonLine);
            }
        }
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        flushBuffer();
    }
    flushBuffer();
    emit('done', {requestId, full});
    logRequest('llm:ollama:stream', 'ok', {requestId, model, streaming: true});
}

async function streamChatCompletion(
    prompt: string,
    requestId: string,
    settings: AppSettings,
    controller: AbortController
): Promise<void> {
    const host = settings.llmHost === 'local' ? 'local' : 'api';
    const model = host === 'local'
        ? settings.localLlmModel || settings.llmModel || DEFAULT_LOCAL_LLM
        : settings.apiLlmModel || settings.llmModel || DEFAULT_API_LLM;

    logRequest('llm:stream', 'start', {requestId, host, model});

    if (host === 'local') {
        await streamOllamaChatCompletion(prompt, requestId, settings, controller);
        return;
    }

    if (GEMINI_LLM_SET.has(model)) {
        const full = await chatWithGemini(prompt, settings, model, controller.signal);
        emit('delta', {requestId, delta: full});
        emit('done', {requestId, full});
        logRequest('llm:stream', 'ok', {requestId, host, model, streaming: false});
        return;
    }

    const apiKey = ensureOpenAiKey(settings);
    const url = `${OPENAI_BASE}/v1/chat/completions`;
    const body = {
        model,
        temperature: 0.3,
        stream: true,
        messages: [
            {
                role: 'system',
                content: (settings.llmPrompt || '').trim() || undefined,
            },
            {
                role: 'user',
                content: prompt,
            },
        ].filter(Boolean),
    };
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
            const trimmed = part.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            const line = trimmed.startsWith('data:')
                ? trimmed.slice(5).trim()
                : trimmed;
            if (!line) continue;
            try {
                const json = JSON.parse(line);
                const delta = json?.choices?.[0]?.delta?.content;
                if (!delta) continue;
                let text = '';
                if (Array.isArray(delta)) {
                    text = delta
                        .map((entry: any) => {
                            if (typeof entry === 'string') return entry;
                            if (entry?.text) return entry.text;
                            if (entry?.content) return entry.content;
                            return '';
                        })
                        .join('');
                } else if (typeof delta === 'string') {
                    text = delta;
                } else if (delta?.content) {
                    text = delta.content;
                }
                if (!text) continue;
                full += text;
                emit('delta', { requestId, delta: text });
            } catch (error) {
                console.warn('[assistantBridge] failed to parse chunk', error, line);
            }
        }
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        flushBuffer();
    }
    flushBuffer();
    emit('done', { requestId, full });
    logRequest('llm:stream', 'ok', {requestId, host, model, streaming: true});
}

export async function assistantProcessAudio(args: ProcessAudioArgs): Promise<AssistantResponse> {
    const settings = await loadSettings();
    const buffer = args.arrayBuffer;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
        return { ok: false, error: 'Empty audio' };
    }
    const transcriptionMode = settings.transcriptionMode || 'api';
    const transcriptionModel = transcriptionMode === 'local'
        ? settings.localWhisperModel || DEFAULT_LOCAL_TRANSCRIBE
        : settings.transcriptionModel || DEFAULT_API_TRANSCRIBE;

    logRequest('transcribe', 'start', {mode: transcriptionMode, model: transcriptionModel, mime: args.mime});

    let text = '';
    if (transcriptionMode === 'local') {
        text = await transcribeWithLocal(buffer, args.mime, args.filename || 'lastN.webm', settings);
    } else if (GOOGLE_TRANSCRIBE_SET.has(transcriptionModel)) {
        text = await transcribeWithGoogle(buffer, args.mime, settings, transcriptionModel);
    } else {
        text = await transcribeWithOpenAi(
            buffer,
            args.mime,
            args.filename || 'lastN.webm',
            settings,
            transcriptionModel
        );
    }

    const llmHost = settings.llmHost === 'local' ? 'local' : 'api';
    const llmModel = llmHost === 'local'
        ? settings.localLlmModel || settings.llmModel || DEFAULT_LOCAL_LLM
        : settings.apiLlmModel || settings.llmModel || DEFAULT_API_LLM;
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
        } else if (GEMINI_LLM_SET.has(llmModel)) {
            answer = await chatWithGemini(text, settings, llmModel);
        } else {
            answer = await chatCompletion(text, settings, llmModel);
        }
    }
    logRequest('transcribe+llm', 'ok', {mode: transcriptionMode, model: transcriptionModel, llmHost, llmModel});
    return { ok: true, text, answer };
}

export async function assistantTranscribeOnly(args: ProcessAudioArgs): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const settings = await loadSettings();
    const buffer = args.arrayBuffer;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
        return { ok: false, error: 'Empty audio' };
    }
    const transcriptionMode = settings.transcriptionMode || 'api';
    const transcriptionModel = transcriptionMode === 'local'
        ? settings.localWhisperModel || DEFAULT_LOCAL_TRANSCRIBE
        : settings.transcriptionModel || DEFAULT_API_TRANSCRIBE;
    logRequest('transcribe', 'start', {mode: transcriptionMode, model: transcriptionModel, mime: args.mime});
    const text = await (async () => {
        if (transcriptionMode === 'local') {
            return transcribeWithLocal(buffer, args.mime, args.filename || 'lastN.webm', settings);
        }
        if (GOOGLE_TRANSCRIBE_SET.has(transcriptionModel)) {
            return transcribeWithGoogle(buffer, args.mime, settings, transcriptionModel);
        }
        return transcribeWithOpenAi(
            buffer,
            args.mime,
            args.filename || 'lastN.webm',
            settings,
            transcriptionModel
        );
    })();
    logRequest('transcribe', 'ok', {mode: transcriptionMode, model: transcriptionModel});
    return { ok: true, text };
}

export async function assistantProcessAudioStream(args: ProcessAudioArgs): Promise<AssistantResponse> {
    const settings = await loadSettings();
    const buffer = args.arrayBuffer;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
        return { ok: false, error: 'Empty audio' };
    }
    const requestId = args.requestId || crypto.randomUUID();
    emit('transcript', { requestId, delta: '' });
    const transcriptionMode = settings.transcriptionMode || 'api';
    const transcriptionModel = transcriptionMode === 'local'
        ? settings.localWhisperModel || DEFAULT_LOCAL_TRANSCRIBE
        : settings.transcriptionModel || DEFAULT_API_TRANSCRIBE;
    logRequest('transcribe', 'start', {mode: transcriptionMode, model: transcriptionModel, mime: args.mime, stream: true});
    const text = await (async () => {
        if (transcriptionMode === 'local') {
            return transcribeWithLocal(buffer, args.mime, args.filename || 'lastN.webm', settings);
        }
        if (GOOGLE_TRANSCRIBE_SET.has(transcriptionModel)) {
            return transcribeWithGoogle(buffer, args.mime, settings, transcriptionModel);
        }
        return transcribeWithOpenAi(
            buffer,
            args.mime,
            args.filename || 'lastN.webm',
            settings,
            transcriptionModel
        );
    })();
    emit('transcript', { requestId, delta: text });
    const controller = new AbortController();
    activeStreams.set(requestId, controller);

    const llmHost = settings.llmHost === 'local' ? 'local' : 'api';
    const llmModel = llmHost === 'local'
        ? settings.localLlmModel || settings.llmModel || DEFAULT_LOCAL_LLM
        : settings.apiLlmModel || settings.llmModel || DEFAULT_API_LLM;
    logRequest('llm:stream', 'start', {
        requestId,
        host: llmHost,
        model: llmModel,
        rawHost: settings.llmHost,
        rawApiModel: settings.apiLlmModel,
        rawLocalModel: settings.localLlmModel,
        rawLlmModel: settings.llmModel,
    });

    streamChatCompletion(text, requestId, settings, controller).catch((error) => {
        if (controller.signal.aborted) return;
        logRequest('llm:stream', 'error', {requestId, error: error instanceof Error ? error.message : String(error)});
        emit('error', {
            requestId,
            error: error instanceof Error ? error.message : String(error),
        });
    }).finally(() => {
        activeStreams.delete(requestId);
    });
    return { ok: true, text, answer: '' };
}

export async function assistantAskChat(args: { text: string; requestId?: string }) {
    const settings = await loadSettings();
    const requestId = args.requestId || crypto.randomUUID();
    const controller = new AbortController();
    activeStreams.set(requestId, controller);
    streamChatCompletion(args.text, requestId, settings, controller).catch((error) => {
        if (controller.signal.aborted) return;
        logRequest('llm:stream', 'error', {requestId, error: error instanceof Error ? error.message : String(error)});
        emit('error', {
            requestId,
            error: error instanceof Error ? error.message : String(error),
        });
    }).finally(() => {
        activeStreams.delete(requestId);
    });
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
    streamEvents.transcript.add(cb);
}

export function assistantOnStreamDelta(cb: StreamListener<{ requestId?: string; delta: string }>) {
    streamEvents.delta.add(cb);
}

export function assistantOnStreamDone(cb: StreamListener<{ requestId?: string; full: string }>) {
    streamEvents.done.add(cb);
}

export function assistantOnStreamError(cb: StreamListener<{ requestId?: string; error: string }>) {
    streamEvents.error.add(cb);
}

export function assistantOffStreamTranscript(cb?: StreamListener<{ requestId?: string; delta: string }>) {
    if (cb) {
        streamEvents.transcript.delete(cb);
    } else {
        streamEvents.transcript.clear();
    }
}

export function assistantOffStreamDelta(cb?: StreamListener<{ requestId?: string; delta: string }>) {
    if (cb) {
        streamEvents.delta.delete(cb);
    } else {
        streamEvents.delta.clear();
    }
}

export function assistantOffStreamDone(cb?: StreamListener<{ requestId?: string; full: string }>) {
    if (cb) {
        streamEvents.done.delete(cb);
    } else {
        streamEvents.done.clear();
    }
}

export function assistantOffStreamError(cb?: StreamListener<{ requestId?: string; error: string }>) {
    if (cb) {
        streamEvents.error.delete(cb);
    } else {
        streamEvents.error.clear();
    }
}

export async function processScreenImage(
    payload: ScreenProcessRequest
): Promise<ScreenProcessResponse> {
    const settings = await loadSettings();
    const apiKey = ensureOpenAiKey(settings);
    const url = `${OPENAI_BASE}/v1/chat/completions`;
    const prompt = (settings.screenProcessingPrompt || '').trim();
    const model = settings.screenProcessingModel === 'google'
        ? 'gpt-4o-mini'
        : 'gpt-4o-mini';
    const userPrompt = prompt || 'Analyze the provided screenshot.';

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
                {
                    role: 'system',
                    content: settings.screenProcessingPrompt || 'You are an assistant that analyses screenshots.',
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: userPrompt },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:${payload.mime};base64,${payload.imageBase64}`,
                            },
                        },
                    ],
                },
            ],
        }),
    });
    const data = await response.json().catch(async () => ({ text: await response.text() }));
    if (!response.ok) {
        return {
            ok: false,
            error: typeof data === 'string' ? data : data?.error?.message || 'Screen processing failed',
        };
    }
    const answer = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(answer)
        ? answer.map((entry: any) => entry?.text || entry?.content || '').join('')
        : answer;
    return {
        ok: true,
        answer: typeof text === 'string' ? text.trim() : '',
    };
}
