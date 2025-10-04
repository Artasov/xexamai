import OpenAI from 'openai';
import {getConfig} from '../config.service';
import {withRetry} from '../retry.service';
import {DefaultTimeoutConfig} from '../timeout.config';

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

    return withRetry(
        async () => {
            const completion = await getClient().chat.completions.create({
                model: cfg.chatModel,
                messages: [
                    {
                        role: 'system',
                        content:
                            'You are a concise, helpful assistant. If the input is a partial question transcribed from audio, infer missing parts prudently and provide a clear answer. If you are unsure, ask a clarifying question.',
                    },
                    {role: 'user', content: prompt},
                ],
                temperature: 0.3,
            });

            const msg = completion.choices[0]?.message?.content?.trim() ?? '';
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

    return withRetry(
        async () => {
            const stream = await getClient().chat.completions.create({
                model: cfg.chatModel,
                messages: [
                    {
                        role: 'system',
                        content:
                            'You are a concise, helpful assistant. If the input is a partial question transcribed from audio, infer missing parts prudently and provide a clear answer. If you are unsure, ask a clarifying question.',
                    },
                    {role: 'user', content: prompt},
                ],
                temperature: 0.3,
                stream: true,
            } as any);

            for await (const chunk of stream as any) {
                try {
                    const delta = chunk?.choices?.[0]?.delta?.content;
                    if (typeof delta === 'string' && delta.length > 0) onDelta(delta);
                } catch {
                }
            }
            if (onDone) onDone();
        },
        cfg.retryConfig,
        'ChatGPT streaming',
        DefaultTimeoutConfig.chatgptTimeoutMs
    );
}

