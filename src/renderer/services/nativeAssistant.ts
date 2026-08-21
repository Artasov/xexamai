import {invokeNative as invoke} from '../bridge/nativeInvoke';
import {beginNativeRendererActivity} from '../state/rendererActivity';
import {
    AskChatRequest,
    AppSettings,
    ChatHistoryMessage,
    ProcessAudioArgs,
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
import {getSiteBaseUrl, getWsBaseUrl} from '@shared/appUrls';
import {AuthError, authClient} from './authClient';
import {uploadMediaFile} from './mediaClient';
import {decodeBase64Bytes, StreamFrameParser} from '../utils/streamFrames';
import {providerProxyFetch} from './providerProxyClient';

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
    return invoke('config_get');
}

function assertWinkySession(): void {
    if (!authClient.hasTokens()) {
        throw new Error('Sign in to use Winky models.');
    }
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
    model?: string,
    requestId?: string,
): Promise<string> {
    const resolvedModel = model || settings.transcriptionModel || DEFAULT_API_TRANSCRIBE;
    const prompt = buildTranscriptionPrompt(settings);

    logRequest('transcribe:openai', 'start', {model: resolvedModel, mime});

    try {
        const result = await invoke('transcribe_audio', {
            request: {
                request_id: requestId,
                mode: 'api',
                model: resolvedModel,
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

type StreamTimeouts = { connectMs: number; idleMs: number; totalMs: number };

const resolveStreamTimeouts = (configured?: number): StreamTimeouts => {
    const totalMs = Math.max(10_000, Math.min(3_600_000, configured || 150_000));
    return {
        connectMs: Math.min(15_000, totalMs),
        idleMs: Math.min(60_000, Math.max(10_000, Math.floor(totalMs / 3))),
        totalMs,
    };
};

async function readStreamingText(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    controller: AbortController,
    timeouts: StreamTimeouts,
    onText: (text: string) => void,
): Promise<void> {
    const deadline = Date.now() + timeouts.totalMs;
    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            controller.abort('total-timeout');
            throw new Error('Generation exceeded its total timeout.');
        }
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const read = reader.read();
        const idleMs = Math.min(timeouts.idleMs, remaining);
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
            result = await Promise.race([
                read,
                new Promise<never>((_resolve, reject) => {
                    timeoutHandle = setTimeout(() => reject(new Error(
                        remaining <= timeouts.idleMs
                            ? 'Generation exceeded its total timeout.'
                            : 'Generation stream became idle.',
                    )), idleMs);
                }),
            ]);
        } catch (error) {
            controller.abort('stream-timeout');
            void reader.cancel().catch(() => undefined);
            throw error;
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        if (result.done) break;
        if (result.value) onText(decoder.decode(result.value, {stream: true}));
    }
    onText(decoder.decode());
}

async function transcribeWithLocal(
    buffer: ArrayBuffer,
    mime: string,
    filename: string,
    settings: AppSettings,
    requestId?: string,
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
        const result = await invoke('transcribe_audio', {
            request: {
                request_id: requestId,
                mode: 'local',
                model,
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
    model?: string,
    requestId?: string,
): Promise<string> {
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
        const result = await invoke('transcribe_audio', {
            request: {
                request_id: requestId,
                mode: 'google',
                model: resolvedModel,
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

async function transcribeWithWinky(
    buffer: ArrayBuffer,
    mime: string,
    settings: AppSettings
): Promise<string> {
    assertWinkySession();
    const fileName = getAudioFileNameByMime(mime);
    const blob = new Blob([buffer], {type: mime || 'audio/webm'});
    const modelLevel = mapWinkyModelToLevel(settings.transcriptionModel || 'winky-transcribe');

    logRequest('transcribe:winky', 'start', {
        model: settings.transcriptionModel || 'winky-transcribe',
        modelLevel,
        mime,
        fileName,
        bufferSize: buffer.byteLength,
    });

    try {
        const media = await uploadMediaFile(blob, {
            namespace: 'ai/transcriptions',
            visibility: 'private',
            fileName,
            contentType: mime || 'audio/webm',
        });
        const data = await authClient.request({
            url: '/ai/transcribe/media/',
            method: 'POST',
            timeout: settings.apiSttTimeoutMs,
            data: {
                media_file_id: media.id,
                model: modelLevel,
            },
        });
        const text = extractSpeechText(data)?.trim();
        if (!text) {
            throw new Error('Winky returned empty transcription.');
        }

        logRequest('transcribe:winky', 'ok', {
            mediaFileId: media.id,
            textPreview: previewText(text),
        });
        return text;
    } catch (error) {
        if (error instanceof AuthError && error.status === 402) {
            const data = error.details as any;
            throw createCreditsError(
                typeof data === 'string'
                    ? data
                    : data?.error?.message || data?.detail || data?.message
            );
        }
        throw error;
    }
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
    const resolvedModel = model || settings.llmModel || settings.apiLlmModel || GEMINI_LLM_MODELS[0] || 'gemini-3.1-pro-preview';
    logRequest('llm:gemini', 'start', {model: resolvedModel, promptPreview: previewText(prompt)});
    const body = buildGeminiBody(prompt, settings, history);
    let logged = false;
    try {
        const response = await providerProxyFetch('google', 'generateContent', body, {
            model: resolvedModel,
            signal,
            timeoutMs: settings.apiLlmTimeoutMs,
        });
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
    assertWinkySession();
    const releaseActivity = await beginNativeRendererActivity('Winky generation');
    try {
    const wsToken = await authClient.wsTicket();
    if (controller?.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }
    const wsUrl = `${getWsBaseUrl()}/ws/ai/llm/`;
    const modelLevel = mapWinkyModelToLevel(model);
    const timeouts = resolveStreamTimeouts(settings.apiLlmTimeoutMs);

    return await new Promise<string>((resolve, reject) => {
        let full = '';
        let settled = false;
        let connectTimer: ReturnType<typeof setTimeout> | null = null;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let totalTimer: ReturnType<typeof setTimeout> | null = null;
        // Keep the short-lived ticket out of URLs, browser history, reverse-proxy
        // access logs, crash reports, and referrers.
        const ws = new WebSocket(wsUrl, [`xexamai-ticket.${wsToken}`]);

        const cleanup = () => {
            if (connectTimer) clearTimeout(connectTimer);
            if (idleTimer) clearTimeout(idleTimer);
            if (totalTimer) clearTimeout(totalTimer);
            connectTimer = idleTimer = totalTimer = null;
            controller?.signal.removeEventListener('abort', onAbort);
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

        const armIdleTimer = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => fail(new Error('Winky response stream became idle.')), timeouts.idleMs);
        };

        connectTimer = setTimeout(() => fail(new Error('Winky connection timed out.')), timeouts.connectMs);
        totalTimer = setTimeout(() => fail(new Error('Winky generation exceeded its total timeout.')), timeouts.totalMs);

        if (controller) {
            if (controller.signal.aborted) {
                onAbort();
                return;
            }
            controller.signal.addEventListener('abort', onAbort, {once: true});
        }

        ws.onopen = () => {
            try {
                if (connectTimer) clearTimeout(connectTimer);
                connectTimer = null;
                armIdleTimer();
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
                armIdleTimer();
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
    } finally {
        await releaseActivity();
    }
}

async function streamGeminiChatCompletion(
    prompt: string,
    requestId: string,
    settings: AppSettings,
    model: string,
    history: ChatHistoryMessage[] | undefined,
    controller: AbortController
): Promise<void> {
    const resolvedModel = model || settings.llmModel || settings.apiLlmModel || GEMINI_LLM_MODELS[0] || 'gemini-3.1-pro-preview';
    const body = buildGeminiBody(prompt, settings, history);
    const timeouts = resolveStreamTimeouts(settings.apiLlmTimeoutMs);

    const response = await providerProxyFetch('google', 'streamGenerateContent', body, {
        model: resolvedModel,
        stream: true,
        signal: controller.signal,
        timeoutMs: settings.apiLlmTimeoutMs,
    });
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
    const parser = new StreamFrameParser('sse');
    let full = '';

    const consumeFrames = (frames: string[]) => {
        for (const jsonLine of frames) {
            if (!jsonLine || jsonLine === '[DONE]') continue;
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

    await readStreamingText(reader, decoder, controller, timeouts, (text) => {
        consumeFrames(parser.push(text));
    });
    consumeFrames(parser.finish());

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
    const timeouts = resolveStreamTimeouts(settings.apiLlmTimeoutMs);
    const decoder = new TextDecoder('utf-8');
    const parser = new StreamFrameParser('ndjson');
    let full = '';

    const consumeFrames = (frames: string[]) => {
        for (const jsonLine of frames) {
            if (!jsonLine || jsonLine === '[DONE]') continue;
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

    const onAbort = () => {
        void window.api.ollama.cancelChat(requestId).catch(() => undefined);
    };
    controller.signal.addEventListener('abort', onAbort, {once: true});
    try {
        await window.api.ollama.streamChat({
            requestId,
            body: JSON.stringify({model, messages, stream: true}),
            connectTimeoutMs: timeouts.connectMs,
            idleTimeoutMs: timeouts.idleMs,
            totalTimeoutMs: timeouts.totalMs,
        }, (event) => {
            if (event.kind !== 'chunk' || !event.dataBase64) return;
            const text = decoder.decode(decodeBase64Bytes(event.dataBase64), {stream: true});
            consumeFrames(parser.push(text));
        });
        consumeFrames(parser.finish(decoder.decode()));
    } finally {
        controller.signal.removeEventListener('abort', onAbort);
    }
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!full.trim()) throw new Error('Ollama returned an empty response.');
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
    const timeouts = resolveStreamTimeouts(settings.apiLlmTimeoutMs);
    const response = await providerProxyFetch('openai', 'chatCompletions', body, {
        stream: true,
        signal: controller.signal,
        timeoutMs: settings.apiLlmTimeoutMs,
    });
    if (!response.ok || !response.body) {
        logRequest('llm:stream', 'error', {requestId, status: response.status});
        const text = await response.text();
        throw new Error(text || 'Streaming request failed');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const parser = new StreamFrameParser('sse');
    let full = '';

    const consumeFrames = (frames: string[]) => {
        for (const frame of frames) {
            if (!frame || frame === '[DONE]') continue;
            try {
                const json = JSON.parse(frame);
                const text = extractOpenAiDelta(json);
                if (!text) continue;
                full += text;
                emit('delta', {requestId, delta: text});
            } catch (error) {
                console.warn('[assistantBridge] failed to parse chunk', error, frame);
            }
        }
    };

    await readStreamingText(reader, decoder, controller, timeouts, (text) => {
        consumeFrames(parser.push(text));
    });
    consumeFrames(parser.finish());
    if (!full.trim()) throw new Error('The model returned an empty response.');
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
    requestId?: string;
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
                                          requestId,
                                     }: TranscriptionRunOptions): Promise<TranscriptionRunResult> {
    const {mode: transcriptionMode, model: transcriptionModel} = resolveTranscriptionTarget(settings);

    const logPayload = buildTranscriptionLogContext(transcriptionMode, transcriptionModel, mime, stream);
    logRequest('transcribe', 'start', logPayload);

    const text = await (async () => {
        if (transcriptionMode === 'local') {
            return transcribeWithLocal(buffer, mime, filename, settings, requestId);
        }
        if (WINKY_TRANSCRIBE_SET.has(transcriptionModel)) {
            return transcribeWithWinky(buffer, mime, settings);
        }
        if (GOOGLE_TRANSCRIBE_SET.has(transcriptionModel)) {
            return transcribeWithGoogle(buffer, mime, settings, transcriptionModel, requestId);
        }
        return transcribeWithOpenAi(buffer, mime, filename, settings, transcriptionModel, requestId);
    })();

    logRequest('transcribe', 'ok', {
        ...logPayload,
        textPreview: previewText(text),
    });

    return {text, mode: transcriptionMode, model: transcriptionModel};
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
        requestId: args.requestId,
    });
    return {ok: true, text};
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
    await invoke('cancel_transcription', {requestId}).catch(() => undefined);
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

export {cancelScreenProcessing, processScreenImage} from './screenProcessing';

