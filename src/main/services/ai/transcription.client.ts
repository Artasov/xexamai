import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { getConfig } from '../config.service';
import type { AppConfig } from '../config.service';
import { withRetry } from '../retry.service';
import { calculateWhisperTimeout, DefaultTimeoutConfig } from '../timeout.config';
import { logger } from '../logger.service';

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

export async function transcribeAudio(
    buffer: Buffer,
    filename = 'audio.webm',
    _mime: string = 'audio/webm',
    audioSeconds?: number
): Promise<string> {
    const cfg = getConfig();

    if (cfg.transcriptionMode === 'local') {
        return await transcribeAudioLocal(buffer, cfg, filename, _mime, audioSeconds);
    } else {
        return await transcribeAudioApi(buffer, cfg, filename, _mime, audioSeconds);
    }
}

function mapLocalModelName(name?: string): string {
    const m = (name || '').toLowerCase();
    if (m === 'large-v2') return 'large';
    if (m === 'large-v3') return 'large-v3';
    return m || 'base';
}

async function transcribeAudioLocal(
    buffer: Buffer,
    cfg: AppConfig,
    filename = 'audio.webm',
    _mime: string = 'audio/webm',
    audioSeconds?: number
): Promise<string> {
    logger.info('transcription', 'Starting local Whisper transcription (local HTTP API)', {
        bufferSize: buffer.length,
        filename, 
        mime: _mime, 
        model: cfg.localWhisperModel,
        device: cfg.localDevice || 'cpu',
        audioSeconds,
    });

    try {
        const base = (process.env.LOCAL_WHISPER_API_BASE || 'http://localhost:8000').replace(/\/$/, '');
        const url = `${base}/v1/audio/transcriptions`;

        const form = new FormData();
        form.append('model', mapLocalModelName(cfg.localWhisperModel));
        form.append('response_format', 'json');
        form.append('device', cfg.localDevice || 'cpu');
        const blob = new Blob([new Uint8Array(buffer)], { type: _mime });
        form.append('file', blob, filename);

        logger.info('transcription', 'Sending HTTP request to Local Whisper', {
            url,
            model: mapLocalModelName(cfg.localWhisperModel),
            device: cfg.localDevice || 'cpu',
            responseFormat: 'json',
            hasFile: true,
        });

        const res = await fetch(url, { method: 'POST', body: form as any });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Local Whisper HTTP ${res.status}: ${errText}`);
        }
        const data: any = await res.json().catch(async () => ({ text: await res.text() }));
        const text: string = (data && (data.text || data?.data?.text)) || '';

        logger.info('transcription', 'Local Whisper transcription completed', {
            textLength: text.length,
            model: cfg.localWhisperModel,
            device: cfg.localDevice || 'cpu',
            transcribedText: text,
        });
        return text;
    } catch (error) {
        logger.error('transcription', 'Local Whisper transcription failed', {
            error: error instanceof Error ? error.message : String(error),
            model: cfg.localWhisperModel,
            device: cfg.localDevice || 'cpu',
        });
        throw (error instanceof Error ? error : new Error(String(error)));
    }
}

async function transcribeAudioApi(
    buffer: Buffer,
    cfg: AppConfig,
    filename = 'audio.webm',
    _mime: string = 'audio/webm',
    audioSeconds?: number
): Promise<string> {
    if (!cfg.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');

    logger.info('transcription', 'Starting OpenAI transcription', {
        bufferSize: buffer.length,
        filename,
        mime: _mime,
        model: cfg.transcriptionModel,
        audioSeconds,
        hasPrompt: !!cfg.transcriptionPrompt,
        prompt: cfg.transcriptionPrompt || null,
        apiKey: cfg.openaiApiKey ? `${cfg.openaiApiKey.substring(0, 8)}...` : null,
        baseUrl: cfg.openaiBaseUrl || 'https://api.openai.com',
    });

    const timeoutBase = cfg.apiSttTimeoutMs || DefaultTimeoutConfig.whisperTimeoutMs;
    const timeoutMs = audioSeconds
        ? calculateWhisperTimeout(audioSeconds, { ...DefaultTimeoutConfig, whisperTimeoutMs: timeoutBase })
        : timeoutBase;

    return withRetry(
        async () => {
            const file = await toFile(buffer, filename, { type: _mime });
            const transcriptionParams: any = {
                file,
                model: cfg.transcriptionModel,
                response_format: 'json',
                temperature: 0.2,
            };

            if (cfg.transcriptionPrompt && cfg.transcriptionPrompt.trim()) {
                transcriptionParams.prompt = cfg.transcriptionPrompt;
            }

            logger.info('transcription', 'Sending HTTP request to OpenAI', {
                url: `${cfg.openaiBaseUrl || 'https://api.openai.com'}/v1/audio/transcriptions`,
                method: 'POST',
                model: cfg.transcriptionModel,
                hasPrompt: !!cfg.transcriptionPrompt,
                prompt: cfg.transcriptionPrompt || null,
                temperature: 0.2,
                responseFormat: 'json',
            });

            const res = await getClient(cfg).audio.transcriptions.create(transcriptionParams);
            const text = (res as any).text || '';

            logger.info('transcription', 'OpenAI transcription completed', {
                textLength: text.length,
                model: cfg.transcriptionModel,
                transcribedText: text,
                responseTime: Date.now(),
            });

            return text;
        },
        cfg.retryConfig,
        'Audio transcription',
        timeoutMs
    );
}
