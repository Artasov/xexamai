import {GoogleGenAI} from '@google/genai';
import {AppConfig} from '../../config.service';
import {logger} from '../../logger.service';

export async function askChatWithGemini(prompt: string, cfg: AppConfig): Promise<string> {
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

export async function askChatStreamWithGemini(
    prompt: string,
    cfg: AppConfig,
    onDelta: (delta: string) => void,
    options?: { signal?: AbortSignal; shouldCancel?: () => boolean }
): Promise<void> {
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
            } catch {
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

export async function processScreenImageWithGemini(
    image: Buffer,
    mime: string,
    userPrompt: string,
    cfg: AppConfig,
    model: string,
    systemPrompt: string
): Promise<string> {
    if (!cfg.geminiApiKey) throw new Error('GEMINI_API_KEY is not set');

    const ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
    const inlineData = image.toString('base64');

    logger.info('gemini', 'Starting Gemini screen analysis', {
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

    logger.info('gemini', 'Gemini screen analysis completed', {
        responseLength: answer.length,
        model,
    });

    return answer;
}
