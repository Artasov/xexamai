import {GoogleGenAI} from '@google/genai';
import {AppConfig} from '../../config.service';
import {logger} from '../../logger.service';

export async function askChatWithGoogle(prompt: string, cfg: AppConfig): Promise<string> {
    if (!cfg.googleApiKey) throw new Error('GOOGLE_API_KEY is not set');

    logger.info('google', 'Starting Google chat completion', {
        promptLength: prompt.length,
        model: cfg.chatModel,
        apiKey: cfg.googleApiKey ? `${cfg.googleApiKey.substring(0, 8)}...` : null,
    });

    const ai = new GoogleGenAI({ apiKey: cfg.googleApiKey });
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

    logger.info('google', 'Google chat completion finished', {
        responseLength: msg.length,
        model: cfg.chatModel,
    });

    return msg;
}

export async function askChatStreamWithGoogle(
    prompt: string,
    cfg: AppConfig,
    onDelta: (delta: string) => void,
    options?: { signal?: AbortSignal; shouldCancel?: () => boolean }
): Promise<void> {
    if (!cfg.googleApiKey) throw new Error('GOOGLE_API_KEY is not set');

    logger.info('google', 'Starting Google chat stream', {
        promptLength: prompt.length,
        model: cfg.chatModel,
    });

    const ai = new GoogleGenAI({ apiKey: cfg.googleApiKey });
    const systemMessage = cfg.llmPrompt;

    const stream = await ai.models.generateContentStream({
        model: cfg.chatModel,
        contents: prompt,
        config: {
            systemInstruction: systemMessage,
            temperature: 0.3,
        },
    });

    let totalLength = 0;
    let chunkCount = 0;
    let cancelled = false;

    try {
        for await (const chunk of stream) {
            if (options?.shouldCancel?.()) {
                cancelled = true;
                break;
            }
            try {
                const delta = chunk.text;
                if (typeof delta === 'string' && delta.length > 0) {
                    totalLength += delta.length;
                    chunkCount++;
                    onDelta(delta);
                }
            } catch {
            }
        }
    } catch (error) {
        logger.error('google', 'Google chat stream error', { error });
        throw error;
    }

    if (cancelled) {
        logger.info('google', 'Google chat stream cancelled by client', {
            model: cfg.chatModel,
            totalResponseLength: totalLength,
            chunkCount,
        });
        return;
    }

    logger.info('google', 'Google chat stream completed', {
        totalResponseLength: totalLength,
        model: cfg.chatModel,
        chunkCount,
    });
}

export async function processScreenImageWithGoogle(
    image: Buffer,
    mime: string,
    userPrompt: string,
    cfg: AppConfig,
    model: string,
    systemPrompt: string
): Promise<string> {
    if (!cfg.googleApiKey) throw new Error('GOOGLE_API_KEY is not set');

    const ai = new GoogleGenAI({ apiKey: cfg.googleApiKey });
    const inlineData = image.toString('base64');

    logger.info('google', 'Starting Google screen analysis', {
        model,
        imageBytes: image.length,
        mime,
    });

    const response = await ai.models.generateContent({
        model,
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
            systemInstruction: systemPrompt,
        },
    });

    const answer = (response.text || '').trim();

    logger.info('google', 'Google screen analysis completed', {
        responseLength: answer.length,
        model,
    });

    return answer;
}
