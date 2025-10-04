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

export async function askChat(prompt: string): Promise<string> {
    const cfg = getConfig();
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
            const systemMessage = 'You are a concise, helpful assistant. If the input is a partial question transcribed from audio, infer missing parts prudently and provide a clear answer. If you are unsure, ask a clarifying question.';
            
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
    if (!cfg.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');

    logger.info('chatgpt', 'Starting OpenAI chat stream', { 
        promptLength: prompt.length,
        model: cfg.chatModel,
        promptText: prompt,
        apiKey: cfg.openaiApiKey ? `${cfg.openaiApiKey.substring(0, 8)}...` : null,
        baseUrl: cfg.openaiBaseUrl || 'https://api.openai.com'
    });

    return withRetry(
        async () => {
            const systemMessage = 'You are a concise, helpful assistant. If the input is a partial question transcribed from audio, infer missing parts prudently and provide a clear answer. If you are unsure, ask a clarifying question.';
            
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

