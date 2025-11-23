import {invoke} from '@tauri-apps/api/core';
import {
    AssistantResponse,
    ProcessAudioArgs,
    StopStreamRequest,
    AppSettings,
    ScreenProcessRequest,
    ScreenProcessResponse,
} from '@shared/ipc';

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

function ensureApiKey(settings: AppSettings): string {
    const key = settings.openaiApiKey?.trim();
    if (!key) {
        throw new Error('OPENAI_API_KEY is not set');
    }
    return key;
}

async function transcribeWithOpenAi(
    buffer: ArrayBuffer,
    mime: string,
    filename: string,
    settings: AppSettings
): Promise<string> {
    const apiKey = ensureApiKey(settings);
    const url = `${OPENAI_BASE}/v1/audio/transcriptions`;
    const form = new FormData();
    const model = settings.transcriptionModel || 'gpt-4o-mini-transcribe';
    form.append('model', model);

    const file = new File([buffer], filename, { type: mime || 'audio/webm' });
    form.append('file', file);

    if (settings.transcriptionPrompt?.trim()) {
        form.append('prompt', settings.transcriptionPrompt.trim());
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
        body: form,
    });

    const data = await response.json().catch(async () => ({ text: await response.text() }));
    if (!response.ok) {
        const message = typeof data === 'string'
            ? data
            : data?.error?.message || 'Transcription failed';
        throw new Error(message);
    }
    return (data as any)?.text || '';
}

async function chatCompletion(
    prompt: string,
    settings: AppSettings
): Promise<string> {
    const apiKey = ensureApiKey(settings);
    const url = `${OPENAI_BASE}/v1/chat/completions`;
    const body = {
        model: settings.llmModel || settings.apiLlmModel || 'gpt-4.1-nano',
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
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(async () => ({ text: await response.text() }));
    if (!response.ok) {
        const message = typeof data === 'string'
            ? data
            : data?.error?.message || 'LLM request failed';
        throw new Error(message);
    }
    return data?.choices?.[0]?.message?.content?.trim() || '';
}

async function streamChatCompletion(
    prompt: string,
    requestId: string,
    settings: AppSettings,
    controller: AbortController
): Promise<void> {
    const apiKey = ensureApiKey(settings);
    const url = `${OPENAI_BASE}/v1/chat/completions`;
    const body = {
        model: settings.llmModel || settings.apiLlmModel || 'gpt-4.1-nano',
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
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
    });
    if (!response.ok || !response.body) {
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
}

export async function assistantProcessAudio(args: ProcessAudioArgs): Promise<AssistantResponse> {
    const settings = await loadSettings();
    const buffer = args.arrayBuffer;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
        return { ok: false, error: 'Empty audio' };
    }
    const text = await transcribeWithOpenAi(
        buffer,
        args.mime,
        args.filename || 'lastN.webm',
        settings
    );
    const answer = text ? await chatCompletion(text, settings) : '';
    return { ok: true, text, answer };
}

export async function assistantTranscribeOnly(args: ProcessAudioArgs): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const settings = await loadSettings();
    const buffer = args.arrayBuffer;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
        return { ok: false, error: 'Empty audio' };
    }
    const text = await transcribeWithOpenAi(
        buffer,
        args.mime,
        args.filename || 'lastN.webm',
        settings
    );
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
    const text = await transcribeWithOpenAi(
        buffer,
        args.mime,
        args.filename || 'lastN.webm',
        settings
    );
    emit('transcript', { requestId, delta: text });
    const controller = new AbortController();
    activeStreams.set(requestId, controller);
    streamChatCompletion(text, requestId, settings, controller).catch((error) => {
        if (controller.signal.aborted) return;
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
    const apiKey = ensureApiKey(settings);
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
