import OpenAI from 'openai';
import {toFile} from 'openai/uploads';
import {getConfig} from '../config.service';
import {withRetry} from '../retry.service';
import {calculateWhisperTimeout, DefaultTimeoutConfig} from '../timeout.config';

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

export async function transcribeAudio(
    buffer: Buffer,
    filename = 'audio.webm',
    _mime: string = 'audio/webm',
    audioSeconds?: number
): Promise<string> {
    const cfg = getConfig();
    if (!cfg.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');

    const timeoutMs = audioSeconds ? calculateWhisperTimeout(audioSeconds) : DefaultTimeoutConfig.whisperTimeoutMs;

    return withRetry(
        async () => {
            const file = await toFile(buffer, filename, {type: _mime});
            const res = await getClient().audio.transcriptions.create({
                file,
                model: cfg.transcriptionModel,
                response_format: 'json',
                temperature: 0.2,
            } as any);
            const text = (res as any).text || '';
            return text;
        },
        cfg.retryConfig,
        'Audio transcription',
        timeoutMs
    );
}
