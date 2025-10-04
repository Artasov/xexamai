import OpenAI from 'openai';
import {toFile} from 'openai/uploads';
import {getConfig} from '../config.service';
import {withRetry} from '../retry.service';
import {calculateWhisperTimeout, DefaultTimeoutConfig} from '../timeout.config';
import {logger} from '../logger.service';
import {whisperLocalService} from '../whisper-local.service';

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

    // Проверяем режим транскрипции
    if (cfg.transcriptionMode === 'local') {
        return await transcribeAudioLocal(buffer, filename, _mime, audioSeconds);
    } else {
        return await transcribeAudioApi(buffer, filename, _mime, audioSeconds);
    }
}

async function transcribeAudioLocal(
    buffer: Buffer,
    filename = 'audio.webm',
    _mime: string = 'audio/webm',
    audioSeconds?: number
): Promise<string> {
    const cfg = getConfig();
    
    logger.info('transcription', 'Starting local Whisper transcription', { 
        bufferSize: buffer.length, 
        filename, 
        mime: _mime, 
        model: cfg.localWhisperModel,
        audioSeconds
    });

    try {
        // Инициализируем модель если она еще не загружена
        if (!(await whisperLocalService.isModelLoaded(cfg.localWhisperModel))) {
            await whisperLocalService.initialize(cfg.localWhisperModel);
        }

        const text = await whisperLocalService.transcribe(buffer, {
            language: 'ru', // Русский язык по умолчанию
            task: 'transcribe',
            chunk_length_s: audioSeconds ? Math.max(audioSeconds, 10) : 30,
            stride_length_s: 5,
        });

        logger.info('transcription', 'Local Whisper transcription completed', { 
            textLength: text.length,
            model: cfg.localWhisperModel,
            transcribedText: text
        });

        return text;
    } catch (error) {
        logger.error('transcription', 'Local Whisper transcription failed', { 
            error: error instanceof Error ? error.message : String(error),
            model: cfg.localWhisperModel
        });
        
        // Fallback на API если локальное распознавание не удалось
        logger.info('transcription', 'Falling back to API transcription');
        return await transcribeAudioApi(buffer, filename, _mime, audioSeconds);
    }
}

async function transcribeAudioApi(
    buffer: Buffer,
    filename = 'audio.webm',
    _mime: string = 'audio/webm',
    audioSeconds?: number
): Promise<string> {
    const cfg = getConfig();
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
        baseUrl: cfg.openaiBaseUrl || 'https://api.openai.com'
    });

    const timeoutMs = audioSeconds ? calculateWhisperTimeout(audioSeconds) : DefaultTimeoutConfig.whisperTimeoutMs;

    return withRetry(
        async () => {
            const file = await toFile(buffer, filename, {type: _mime});
            const transcriptionParams: any = {
                file,
                model: cfg.transcriptionModel,
                response_format: 'json',
                temperature: 0.2,
            };
            
            // Добавляем промт только если он не пустой
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
                responseFormat: 'json'
            });

            const res = await getClient().audio.transcriptions.create(transcriptionParams);
            const text = (res as any).text || '';
            
            logger.info('transcription', 'OpenAI transcription completed', { 
                textLength: text.length,
                model: cfg.transcriptionModel,
                transcribedText: text,
                responseTime: Date.now()
            });
            
            return text;
        },
        cfg.retryConfig,
        'Audio transcription',
        timeoutMs
    );
}
