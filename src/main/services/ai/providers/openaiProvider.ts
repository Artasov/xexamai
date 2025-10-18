import OpenAI from 'openai';
import {AppConfig} from '../../config.service';
import {logger} from '../../logger.service';

let client: OpenAI | null = null;
let clientSignature: string | null = null;

function getClient(cfg: AppConfig): OpenAI {
    const signature = `${cfg.openaiApiKey || ''}|${cfg.openaiBaseUrl || ''}`;
    if (!client || clientSignature !== signature) {
        clientSignature = signature;
        client = new OpenAI({
            apiKey: cfg.openaiApiKey,
            baseURL: cfg.openaiBaseUrl,
        });
    }
    return client;
}

export async function askChatWithOpenAI(prompt: string, cfg: AppConfig): Promise<string> {
    if (!cfg.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');

    logger.info('chatgpt', 'Starting OpenAI chat completion', {
        promptLength: prompt.length,
        model: cfg.chatModel,
        promptText: prompt,
        apiKey: cfg.openaiApiKey ? `${cfg.openaiApiKey.substring(0, 8)}...` : null,
        baseUrl: cfg.openaiBaseUrl || 'https://api.openai.com',
    });

    const systemMessage = cfg.llmPrompt;

    logger.info('chatgpt', 'Sending HTTP request to OpenAI', {
        url: `${cfg.openaiBaseUrl || 'https://api.openai.com'}/v1/chat/completions`,
        method: 'POST',
        model: cfg.chatModel,
        systemMessage,
        userMessage: prompt,
        temperature: 0.3,
        maxTokens: 'not specified',
    });

    const completion = await getClient(cfg).chat.completions.create({
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
            totalTokens: completion.usage?.total_tokens || 0,
        },
        responseTime: Date.now(),
    });

    return msg;
}

export async function askChatStreamWithOpenAI(
    prompt: string,
    cfg: AppConfig,
    onDelta: (delta: string) => void,
    options?: { signal?: AbortSignal; shouldCancel?: () => boolean }
): Promise<void> {
    if (!cfg.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');

    logger.info('chatgpt', 'Starting OpenAI chat stream', {
        promptLength: prompt.length,
        model: cfg.chatModel,
        promptText: prompt,
        apiKey: cfg.openaiApiKey ? `${cfg.openaiApiKey.substring(0, 8)}...` : null,
        baseUrl: cfg.openaiBaseUrl || 'https://api.openai.com',
    });

    const systemMessage = cfg.llmPrompt;

    logger.info('chatgpt', 'Sending HTTP streaming request to OpenAI', {
        url: `${cfg.openaiBaseUrl || 'https://api.openai.com'}/v1/chat/completions`,
        method: 'POST',
        model: cfg.chatModel,
        systemMessage,
        userMessage: prompt,
        temperature: 0.3,
        stream: true,
    });

    const stream = await getClient(cfg).chat.completions.create({
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
        responseTime: Date.now(),
    });
}

export async function processScreenImageWithOpenAI(
    image: Buffer,
    mime: string,
    userPrompt: string,
    cfg: AppConfig,
    model: string,
    systemPrompt: string
): Promise<string> {
    if (!cfg.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');

    const imageBase64 = image.toString('base64');
    const imageUrl = `data:${mime || 'image/png'};base64,${imageBase64}`;

    logger.info('chatgpt', 'Starting OpenAI screen analysis', {
        model,
        imageBytes: image.length,
        mime,
    });

    const completion = await getClient(cfg).chat.completions.create({
        model,
        messages: [
            {
                role: 'system',
                content: systemPrompt,
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
        model,
    });

    return (answer || '').trim();
}
