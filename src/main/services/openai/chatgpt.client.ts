import OpenAI from 'openai';
import {getConfig} from '../config.service';
import {withRetry} from '../retry.service';
import {DefaultTimeoutConfig} from '../timeout.config';
import {logger} from '../logger.service';

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

function isLocalOssModel(model?: string): boolean {
    return typeof model === 'string' && model.startsWith('gpt-oss');
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
    onDone?: () => void
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
            const {done, value} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
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
        if (onDone) onDone();
        logger.info('gpt-oss', 'Local chat stream completed', {model: cfg.chatModel});
    }
}

export async function askChat(prompt: string): Promise<string> {
    const cfg = getConfig();
    if (!isLocalOssModel(cfg.chatModel) && !cfg.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');

    if (isLocalOssModel(cfg.chatModel)) {
        return withRetry(
            async () => askChatLocal(prompt),
            cfg.retryConfig,
            'Local GPT-OSS completion',
            DefaultTimeoutConfig.chatgptTimeoutMs
        );
    }

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
        DefaultTimeoutConfig.chatgptTimeoutMs
    );
}

export async function askChatStream(
    prompt: string,
    onDelta: (delta: string) => void,
    onDone?: () => void
): Promise<void> {
    const cfg = getConfig();
    if (!isLocalOssModel(cfg.chatModel) && !cfg.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');

    if (isLocalOssModel(cfg.chatModel)) {
        return withRetry(
            async () => {
                await askChatStreamLocal(prompt, onDelta, onDone);
            },
            cfg.retryConfig,
            'Local GPT-OSS streaming',
            DefaultTimeoutConfig.chatgptTimeoutMs
        );
    }

    logger.info('chatgpt', 'Starting OpenAI chat stream', { 
        promptLength: prompt.length,
        model: cfg.chatModel,
        promptText: prompt,
        apiKey: cfg.openaiApiKey ? `${cfg.openaiApiKey.substring(0, 8)}...` : null,
        baseUrl: cfg.openaiBaseUrl || 'https://api.openai.com'
    });

    return withRetry(
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
            
            if (onDone) onDone();
        },
        cfg.retryConfig,
        'ChatGPT streaming',
        DefaultTimeoutConfig.chatgptTimeoutMs
    );
}

