import OpenAI from 'openai';
import {getConfig} from '../config.service';
import {withRetry} from '../retry.service';
import {DefaultTimeoutConfig} from '../timeout.config';
import {logger} from '../logger.service';
import {GoogleGenAI} from '@google/genai';
import {DEFAULT_SCREEN_PROMPT} from '../../shared/types';

let client: OpenAI | null = null;

function getClient(): OpenAI {
    if (!client) {
        const cfg = getConfig();
        client = new OpenAI({
            apiKey: cfg.openaiApiKey,
            baseURL: cfg.openaiBaseUrl,
        });
    }
    return client;
}

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

function isGeminiModel(model?: string): boolean {
    return typeof model === 'string' && model.startsWith('gemini-');
}

const LOCAL_LLM_TIMEOUT_MS = 600000; // 600s only for local LLM
const SCREEN_OPENAI_MODEL = 'gpt-4o-mini';
const SCREEN_GEMINI_MODEL = 'gemini-1.5-flash';
const SCREEN_SYSTEM_PROMPT = 'You analyze screenshots to assist with technical interviews. Follow the user\'s instructions exactly and keep responses concise.';

async function askChatGemini(prompt: string): Promise<string> {
    const cfg = getConfig();
    if (!cfg.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');

    logger.info('gemini', 'Starting Gemini chat completion', {
        promptLength: prompt.length,
        model: cfg.chatModel,
        apiKey: cfg.geminiApiKey ? `${cfg.geminiApiKey.substring(0, 8)}...` : null,
    });

    const ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
    const systemMessage = cfg.llmPrompt;

    const response = await ai.models.generateContent({
        model: cfg.chatModel,
        contents: prompt,
        config: {
            systemInstruction: systemMessage,
            temperature: 0.3,
        },
    });

    const msg = response.text || '';

    logger.info('gemini', 'Gemini chat completion finished', {
        responseLength: msg.length,
        model: cfg.chatModel,
    });

    return msg;
}

async function askChatStreamGemini(
    prompt: string,
    onDelta: (delta: string) => void,
    onDone?: () => void,
    options?: { signal?: AbortSignal; shouldCancel?: () => boolean }
): Promise<void> {
    const cfg = getConfig();
    if (!cfg.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');

    logger.info('gemini', 'Starting Gemini chat stream', {
        promptLength: prompt.length,
        model: cfg.chatModel,
    });

    const ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
    const systemMessage = cfg.llmPrompt;

    const stream = await ai.models.generateContentStream({
        model: cfg.chatModel,
        contents: prompt,
        config: {
            systemInstruction: systemMessage,
            temperature: 0.3,
        },
    });

    try {
        let totalLength = 0;
        let chunkCount = 0;

        for await (const chunk of stream) {
            if (options?.shouldCancel?.()) break;
            try {
                const delta = chunk.text;
                if (typeof delta === 'string' && delta.length > 0) {
                    totalLength += delta.length;
                    chunkCount++;
                    onDelta(delta);
                }
            } catch (e) {
                // Ignore chunk parsing errors
            }
        }

        logger.info('gemini', 'Gemini chat stream completed', {
            totalResponseLength: totalLength,
            model: cfg.chatModel,
            chunkCount,
        });
    } catch (error) {
        logger.error('gemini', 'Gemini chat stream error', { error });
        throw error;
    }
}

async function askChatLocal(prompt: string): Promise<string> {
    const cfg = getConfig();
    const url = 'http://localhost:11434/api/chat';
    const systemMessage = cfg.llmPrompt;

    logger.info('gpt-oss', 'Starting local chat completion', {
        promptLength: prompt.length,
        model: cfg.chatModel,
        url,
        stream: false,
    });

    const res = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            model: cfg.chatModel,
            messages: [
                {role: 'system', content: systemMessage},
                {role: 'user', content: prompt},
            ],
            stream: false,
        }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Local chat request failed: ${res.status} ${res.statusText} ${text}`);
    }

    const data: any = await res.json().catch(() => ({}));
    const msg = (data?.message?.content || data?.choices?.[0]?.message?.content || '').toString().trim();

    logger.info('gpt-oss', 'Local chat completion finished', {
        responseLength: msg.length,
        model: cfg.chatModel,
    });

    return msg;
}

async function askChatStreamLocal(
    prompt: string,
    onDelta: (delta: string) => void,
    onDone?: () => void,
    options?: { signal?: AbortSignal; shouldCancel?: () => boolean }
): Promise<void> {
    const cfg = getConfig();
    const url = 'http://localhost:11434/api/chat';
    const systemMessage = cfg.llmPrompt;

    logger.info('gpt-oss', 'Starting local chat stream', {
        promptLength: prompt.length,
        model: cfg.chatModel,
        url,
        stream: true,
    });

    const res = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            model: cfg.chatModel,
            messages: [
                {role: 'system', content: systemMessage},
                {role: 'user', content: prompt},
            ],
            stream: true,
        }),
        signal: options?.signal,
    });

    if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`Local chat stream failed: ${res.status} ${res.statusText} ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
        // Ollama-style NDJSON lines
        while (true) {
            if (options?.shouldCancel?.()) break;
            const {done, value} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                if (options?.shouldCancel?.()) { buffer = ''; break; }
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line) continue;
                try {
                    const obj = JSON.parse(line);
                    // Prefer delta/content depending on server format
                    const delta =
                        (obj?.message?.content ?? obj?.delta ?? obj?.choices?.[0]?.delta?.content ?? '') + '';
                    if (delta) onDelta(delta);
                } catch {
                    // ignore malformed line
                }
            }
        }
        // Flush remaining buffer
        const rest = buffer.trim();
        if (rest) {
            try {
                const obj = JSON.parse(rest);
                const delta = (obj?.message?.content ?? obj?.delta ?? '') + '';
                if (delta) onDelta(delta);
            } catch {
            }
        }
    } finally {
        logger.info('gpt-oss', 'Local chat stream completed', {model: cfg.chatModel});
    }
}

async function processScreenImageOpenAI(image: Buffer, mime: string, prompt: string): Promise<string> {
    const cfg = getConfig();
    if (!cfg.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');

    const imageBase64 = image.toString('base64');
    const imageUrl = `data:${mime || 'image/png'};base64,${imageBase64}`;

    const userPrompt = (prompt && prompt.trim().length > 0 ? prompt.trim() : DEFAULT_SCREEN_PROMPT) + '\n\nScreenshot attached below. Respond according to the instructions.';

    logger.info('chatgpt', 'Starting OpenAI screen analysis', {
        model: SCREEN_OPENAI_MODEL,
        imageBytes: image.length,
        mime,
    });

    const completion = await getClient().chat.completions.create({
        model: SCREEN_OPENAI_MODEL,
        messages: [
            {
                role: 'system',
                content: SCREEN_SYSTEM_PROMPT,
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: userPrompt },
                    { type: 'image_url', image_url: { url: imageUrl } as any },
                ],
            },
        ],
        temperature: 0.2,
        max_tokens: 900,
    });

    const msg = completion.choices?.[0]?.message;
    let answer = '';
    const content = msg?.content as unknown;
    if (typeof content === 'string') {
        answer = content;
    } else if (Array.isArray(content)) {
        answer = (content as Array<any>).map((part: any) => {
            if (typeof part === 'string') return part;
            if (part && typeof part.text === 'string') return part.text;
            if (part && typeof part.content === 'string') return part.content;
            if (part && typeof part.value === 'string') return part.value;
            return '';
        }).join('');
    }

    logger.info('chatgpt', 'OpenAI screen analysis completed', {
        responseLength: answer?.length || 0,
        model: SCREEN_OPENAI_MODEL,
    });

    return (answer || '').trim();
}

async function processScreenImageGoogle(image: Buffer, mime: string, prompt: string): Promise<string> {
    const cfg = getConfig();
    if (!cfg.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');

    const ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
    const inlineData = image.toString('base64');
    const userPrompt = prompt && prompt.trim().length > 0 ? prompt.trim() : DEFAULT_SCREEN_PROMPT;

    logger.info('gemini', 'Starting Gemini screen analysis', {
        model: SCREEN_GEMINI_MODEL,
        imageBytes: image.length,
        mime,
    });

    const response = await ai.models.generateContent({
        model: SCREEN_GEMINI_MODEL,
        contents: [
            {
                role: 'user',
                parts: [
                    { text: `${userPrompt}\n\nScreenshot attached below.` },
                    { inlineData: { mimeType: mime || 'image/png', data: inlineData } },
                ],
            },
        ],
        config: {
            temperature: 0.2,
            systemInstruction: SCREEN_SYSTEM_PROMPT,
        },
    });

    const answer = (response.text || '').trim();

    logger.info('gemini', 'Gemini screen analysis completed', {
        responseLength: answer.length,
        model: SCREEN_GEMINI_MODEL,
    });

    return answer;
}

export async function processScreenImage(image: Buffer, mime: string): Promise<string> {
    const cfg = getConfig();
    const prompt = (cfg.screenProcessingPrompt || DEFAULT_SCREEN_PROMPT).trim() || DEFAULT_SCREEN_PROMPT;
    const provider = cfg.screenProcessingModel || 'openai';
    const timeoutMs = cfg.screenProcessingTimeoutMs || cfg.apiLlmTimeoutMs || DefaultTimeoutConfig.chatgptTimeoutMs;

    if (provider === 'google') {
        return withRetry(
            () => processScreenImageGoogle(image, mime, prompt),
            cfg.retryConfig,
            'Gemini screen processing',
            timeoutMs
        );
    }

    return withRetry(
        () => processScreenImageOpenAI(image, mime, prompt),
        cfg.retryConfig,
        'OpenAI screen processing',
        timeoutMs
    );
}

export async function askChat(prompt: string): Promise<string> {
    const cfg = getConfig();
    
    if (isGeminiModel(cfg.chatModel)) {
        if (!cfg.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');
        return withRetry(
            async () => askChatGemini(prompt),
            cfg.retryConfig,
            'Gemini completion',
            cfg.apiLlmTimeoutMs || DefaultTimeoutConfig.chatgptTimeoutMs
        );
    }

    if (isLocalModel(cfg.chatModel)) {
        return withRetry(
            async () => askChatLocal(prompt),
            cfg.retryConfig,
            'Local GPT-OSS completion',
            LOCAL_LLM_TIMEOUT_MS
        );
    }
    
    if (!cfg.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');

    logger.info('chatgpt', 'Starting OpenAI chat completion', { 
        promptLength: prompt.length,
        model: cfg.chatModel,
        promptText: prompt,
        apiKey: cfg.openaiApiKey ? `${cfg.openaiApiKey.substring(0, 8)}...` : null,
        baseUrl: cfg.openaiBaseUrl || 'https://api.openai.com'
    });

    return withRetry(
        async () => {
            const systemMessage = cfg.llmPrompt;
            
            logger.info('chatgpt', 'Sending HTTP request to OpenAI', {
                url: `${cfg.openaiBaseUrl || 'https://api.openai.com'}/v1/chat/completions`,
                method: 'POST',
                model: cfg.chatModel,
                systemMessage,
                userMessage: prompt,
                temperature: 0.3,
                maxTokens: 'not specified'
            });

            const completion = await getClient().chat.completions.create({
                model: cfg.chatModel,
                messages: [
                    {
                        role: 'system',
                        content: systemMessage,
                    },
                    {role: 'user', content: prompt},
                ],
                temperature: 0.3,
            });

            const msg = completion.choices[0]?.message?.content?.trim() ?? '';
            
            logger.info('chatgpt', 'OpenAI chat completion finished', { 
                responseLength: msg.length,
                model: cfg.chatModel,
                responseText: msg,
                usage: {
                    promptTokens: completion.usage?.prompt_tokens || 0,
                    completionTokens: completion.usage?.completion_tokens || 0,
                    totalTokens: completion.usage?.total_tokens || 0
                },
                responseTime: Date.now()
            });
            
            return msg;
        },
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
    
    if (isGeminiModel(cfg.chatModel)) {
        if (!cfg.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');
        await withRetry(
            async () => {
                await askChatStreamGemini(prompt, onDelta, undefined, options);
            },
            cfg.retryConfig,
            'Gemini streaming',
            cfg.apiLlmTimeoutMs || DefaultTimeoutConfig.chatgptTimeoutMs
        );
        // Call onDone only after successful completion of all retries
        onDone?.();
        return;
    }

    if (isLocalModel(cfg.chatModel)) {
        await withRetry(
            async () => {
                await askChatStreamLocal(prompt, onDelta, undefined, options);
            },
            cfg.retryConfig,
            'Local GPT-OSS streaming',
            LOCAL_LLM_TIMEOUT_MS
        );
        // Call onDone only after successful completion of all retries
        onDone?.();
        return;
    }
    
    if (!cfg.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');

    logger.info('chatgpt', 'Starting OpenAI chat stream', { 
        promptLength: prompt.length,
        model: cfg.chatModel,
        promptText: prompt,
        apiKey: cfg.openaiApiKey ? `${cfg.openaiApiKey.substring(0, 8)}...` : null,
        baseUrl: cfg.openaiBaseUrl || 'https://api.openai.com'
    });

    await withRetry(
        async () => {
            const systemMessage = cfg.llmPrompt;
            
            logger.info('chatgpt', 'Sending HTTP streaming request to OpenAI', {
                url: `${cfg.openaiBaseUrl || 'https://api.openai.com'}/v1/chat/completions`,
                method: 'POST',
                model: cfg.chatModel,
                systemMessage,
                userMessage: prompt,
                temperature: 0.3,
                stream: true
            });

            const stream = await getClient().chat.completions.create({
                model: cfg.chatModel,
                messages: [
                    {
                        role: 'system',
                        content: systemMessage,
                    },
                    {role: 'user', content: prompt},
                ],
                temperature: 0.3,
                stream: true,
            } as any);

            let totalLength = 0;
            let chunkCount = 0;
            for await (const chunk of stream as any) {
                if (options?.shouldCancel?.()) break;
                try {
                    const delta = chunk?.choices?.[0]?.delta?.content;
                    if (typeof delta === 'string' && delta.length > 0) {
                        totalLength += delta.length;
                        chunkCount++;
                        onDelta(delta);
                    }
                } catch {
                }
            }
            
            logger.info('chatgpt', 'OpenAI chat stream completed', { 
                totalResponseLength: totalLength,
                model: cfg.chatModel,
                chunkCount,
                responseTime: Date.now()
            });
        },
        cfg.retryConfig,
        'ChatGPT streaming',
        cfg.apiLlmTimeoutMs || DefaultTimeoutConfig.chatgptTimeoutMs
    );
    
    // Call onDone only after successful completion of all retries
    onDone?.();
}

