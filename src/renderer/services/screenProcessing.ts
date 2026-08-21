import {invokeNative as invoke} from '../bridge/nativeInvoke';
import type {
    AppSettings,
    ChatHistoryMessage,
    ScreenProcessRequest,
    ScreenProcessResponse,
} from '@shared/ipc';
import {logRequest, previewText} from './nativeAssistant.helpers';
import {providerProxyFetch} from './providerProxyClient';

const OPENAI_MODEL = 'gpt-4o-mini';
const GEMINI_MODEL = 'gemini-3.7-flash';
const MAX_HISTORY_MESSAGES = 40;

type ScreenPrompts = {systemPrompt: string; userPrompt: string};
const activeRequests = new Map<string, AbortController>();

export function cancelScreenProcessing(requestId: string): void {
    const controller = activeRequests.get(requestId);
    if (!controller) return;
    controller.abort('user-cancelled');
    activeRequests.delete(requestId);
}

function normalizeHistory(history?: ChatHistoryMessage[]): ChatHistoryMessage[] {
    if (!Array.isArray(history)) return [];
    return history
        .filter((item) => !!item
            && (item.role === 'user' || item.role === 'assistant')
            && typeof item.content === 'string'
            && !!item.content.trim())
        .slice(-MAX_HISTORY_MESSAGES);
}

function buildPrompts(settings: AppSettings): ScreenPrompts {
    return {
        systemPrompt: settings.screenProcessingPrompt?.trim() || 'You are an assistant that analyses screenshots.',
        userPrompt: 'Analyze the provided screenshot and provide actionable insights.',
    };
}

function normalizeBase64(value: string): string {
    const comma = value.indexOf(',');
    return comma >= 0 ? value.slice(comma + 1) : value;
}

async function readResponse(response: Response): Promise<any> {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return {text};
    }
}

function responseError(data: any): string {
    return data?.error?.message || data?.text || 'Screen processing failed';
}

async function processWithOpenAi(
    payload: ScreenProcessRequest,
    settings: AppSettings,
    prompts: ScreenPrompts,
    history: ChatHistoryMessage[],
    signal: AbortSignal,
): Promise<{answer: string; model: string}> {
    const messages: Array<{role: 'system' | 'user' | 'assistant'; content: unknown}> = [];
    if (prompts.systemPrompt) messages.push({role: 'system', content: prompts.systemPrompt});
    messages.push(...history.map((item) => ({role: item.role, content: item.content})));
    messages.push({
        role: 'user',
        content: [
            {type: 'text', text: prompts.userPrompt},
            {type: 'image_url', image_url: {url: `data:${payload.mime || 'image/png'};base64,${payload.imageBase64}`}},
        ],
    });

    const response = await providerProxyFetch('openai', 'screenChatCompletions', {
        model: OPENAI_MODEL,
        temperature: 0.2,
        messages,
    }, {signal, timeoutMs: settings.screenProcessingTimeoutMs});
    const data = await readResponse(response);
    if (!response.ok) throw new Error(responseError(data));
    const answer = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(answer)
        ? answer.map((entry: any) => entry?.text || entry?.content || '').join('')
        : answer;
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) throw new Error('Empty response from OpenAI screen analysis.');
    return {answer: normalized, model: OPENAI_MODEL};
}

function extractGeminiText(data: any): string {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
        const text = parts.map((part: any) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n').trim();
        if (text) return text;
    }
    return typeof data?.text === 'string' ? data.text.trim() : '';
}

async function processWithGemini(
    payload: ScreenProcessRequest,
    settings: AppSettings,
    prompts: ScreenPrompts,
    history: ChatHistoryMessage[],
    signal: AbortSignal,
): Promise<{answer: string; model: string}> {
    const contents: any[] = history.map((item) => ({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: [{text: item.content}],
    }));
    contents.push({
        role: 'user',
        parts: [
            {text: prompts.userPrompt},
            {inline_data: {mime_type: payload.mime || 'image/png', data: payload.imageBase64}},
        ],
    });
    // Gemini 3.7 rejects the legacy temperature/top-p/top-k sampling fields.
    const body: Record<string, unknown> = {contents};
    if (prompts.systemPrompt) {
        body.systemInstruction = {role: 'system', parts: [{text: prompts.systemPrompt}]};
    }
    const response = await providerProxyFetch('google', 'screenGenerateContent', body, {
        model: GEMINI_MODEL,
        signal,
        timeoutMs: settings.screenProcessingTimeoutMs,
    });
    const data = await readResponse(response);
    if (!response.ok) throw new Error(responseError(data));
    const text = extractGeminiText(data);
    if (!text) throw new Error('Empty response from Google screen analysis.');
    return {answer: text, model: GEMINI_MODEL};
}

export async function processScreenImage(payload: ScreenProcessRequest): Promise<ScreenProcessResponse> {
    const settings = await invoke('config_get');
    const requestId = payload.requestId || crypto.randomUUID();
    const controller = new AbortController();
    activeRequests.get(requestId)?.abort('superseded');
    activeRequests.set(requestId, controller);
    const userText = payload.userText?.trim() || '';
    const prompts = buildPrompts(settings);
    const provider = settings.screenProcessingModel === 'google' ? 'google' : 'openai';
    const history = normalizeHistory(payload.history);
    const effectiveUserPrompt = userText ? `${prompts.userPrompt}\n\nUser request: ${userText}` : prompts.userPrompt;
    const normalizedPayload = {...payload, imageBase64: normalizeBase64(payload.imageBase64)};

    logRequest('screen', 'start', {
        provider,
        model: provider === 'google' ? GEMINI_MODEL : OPENAI_MODEL,
        mime: payload.mime,
        width: payload.width,
        height: payload.height,
        historySize: history.length,
        hasUserText: !!userText,
        promptPreview: previewText(effectiveUserPrompt),
    });

    try {
        const effectivePrompts = {...prompts, userPrompt: effectiveUserPrompt};
        const {answer, model} = provider === 'google'
            ? await processWithGemini(normalizedPayload, settings, effectivePrompts, history, controller.signal)
            : await processWithOpenAi(normalizedPayload, settings, effectivePrompts, history, controller.signal);
        logRequest('screen', 'ok', {provider, model, responsePreview: previewText(answer)});
        return {ok: true, answer};
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logRequest('screen', 'error', {provider, mime: payload.mime, error: message});
        return {ok: false, error: message};
    } finally {
        if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
    }
}
