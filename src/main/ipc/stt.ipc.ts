import {desktopCapturer, ipcMain, screen} from 'electron';
import {
    AskChatRequest,
    AssistantResponse,
    IPCChannels,
    SttProcessRequest,
    TranscribeOnlyRequest,
    StopStreamRequest,
    ScreenProcessRequest,
    ScreenProcessResponse,
    ScreenCaptureResponse,
} from '../../shared/ipc';
import {
    askChatWithText,
    processAudioToAnswer,
    processAudioToAnswerStream,
    transcribeAudioOnly,
    processScreenCapture
} from '../services/assistant.service';
import {logger} from '../services/logger.service';
import {formatError} from '../utils/errorFormatter';
import {normalizeAudioInput} from '../utils/audioNormalizer';

export function registerSttIpc() {
    const controllers = new Map<string, { controller: AbortController; cancelled: boolean; sentDone: boolean }>();

    ipcMain.handle(IPCChannels.AssistantProcess, async (_event, payload: SttProcessRequest): Promise<AssistantResponse> => {
        logger.info('stt', 'Processing audio request', { 
            hasAudio: !!(payload as any)?.audio, 
            mime: payload?.mime,
            filename: payload?.filename 
        });
        
        try {
            if (!payload || !(payload as any).audio || !payload.mime) {
                throw new Error('Invalid audio payload');
            }
            const raw = (payload as any).audio;
            const audio = normalizeAudioInput(raw);
            try {
                console.debug('[main.assistant] got audio length:', audio ? audio.length : 'not-buffer', 'mime:', payload.mime, 'filename:', payload.filename);
            } catch {
            }
            if (!audio || audio.length === 0) {
                try {
                    console.warn('[main.assistant] empty or invalid buffer after convert. rawType:', typeof raw);
                } catch {
                }
                throw new Error('Empty audio');
            }
            if (typeof payload.mime !== 'string' || payload.mime.length === 0) {
                throw new Error('MIME type is not specified');
            }
            const MAX_BYTES = 25 * 1024 * 1024;
            if (audio.length > MAX_BYTES) {
                throw new Error('Audio is too large (>25MB)');
            }
            const filename = payload.filename || 'lastN.webm';
            logger.info('stt', 'Starting audio processing', { 
                audioSize: audio.length, 
                filename, 
                mime: payload.mime 
            });
            
            const res = await processAudioToAnswer(audio, filename, payload.mime);
            
            logger.info('stt', 'Audio processing completed', { 
                textLength: res.text?.length || 0,
                answerLength: res.answer?.length || 0 
            });
            
            return {ok: true, text: res.text, answer: res.answer};
        } catch (err: any) {
            const formattedError = formatError(err);
            logger.error('stt', 'Audio processing failed', { error: formattedError.displayText });
            return {ok: false, error: formattedError.displayText};
        }
    });

    ipcMain.handle(IPCChannels.AssistantProcessStream, async (event, payload: SttProcessRequest): Promise<AssistantResponse> => {
        logger.info('stt', 'Processing audio stream request', { 
            hasAudio: !!(payload as any)?.audio, 
            mime: payload?.mime,
            filename: payload?.filename,
            requestId: payload?.requestId 
        });
        
        try {
            if (!payload || !(payload as any).audio || !payload.mime) {
                throw new Error('Invalid audio payload');
            }
            const raw = (payload as any).audio;
            const audio = normalizeAudioInput(raw);
            if (!audio || audio.length === 0) throw new Error('Empty audio');
            const MAX_BYTES = 25 * 1024 * 1024;
            if (audio.length > MAX_BYTES) throw new Error('Audio is too large (>25MB)');
            const filename = payload.filename || 'lastN.webm';
            const requestId = payload.requestId || 'default';

            logger.info('stt', 'Starting audio stream processing', { 
                audioSize: audio.length, 
                filename, 
                mime: payload.mime,
                requestId 
            });

            event.sender.send(IPCChannels.AssistantStreamTranscript, {requestId, delta: ''});
            let accumulated = '';
            const ac = new AbortController();
            controllers.set(requestId, { controller: ac, cancelled: false, sentDone: false });
            const ctx = controllers.get(requestId)!;
            const {text} = await processAudioToAnswerStream(
                audio,
                filename,
                payload.mime,
                (delta) => {
                    if (ctx.cancelled) return;
                    accumulated += delta;
                    event.sender.send(IPCChannels.AssistantStreamDelta, {requestId, delta});
                },
                () => {
                    if (ctx.sentDone) return;
                    ctx.sentDone = true;
                    event.sender.send(IPCChannels.AssistantStreamDone, {requestId, full: accumulated});
                },
                undefined,
                { signal: ac.signal, shouldCancel: () => controllers.get(requestId)?.cancelled === true }
            );
            
            logger.info('stt', 'Audio stream processing completed', { 
                textLength: text?.length || 0,
                accumulatedLength: accumulated.length,
                requestId 
            });
            
            controllers.delete(requestId);
            return {ok: true, text, answer: ''};
        } catch (err: any) {
            const formattedError = formatError(err);
            logger.error('stt', 'Audio stream processing failed', { 
                error: formattedError.displayText,
                requestId: (payload as any)?.requestId 
            });
            event.sender.send(IPCChannels.AssistantStreamError, {
                error: formattedError.displayText,
                requestId: (payload as any)?.requestId
            });
            return {ok: false, error: formattedError.displayText};
        }
    });

    ipcMain.handle(IPCChannels.AssistantTranscribeOnly, async (_event, payload: TranscribeOnlyRequest): Promise<{
        ok: true;
        text: string
    } | { ok: false; error: string }> => {
        logger.info('stt', 'Transcribe only request', { 
            hasAudio: !!(payload as any)?.audio, 
            mime: payload?.mime,
            filename: payload?.filename,
            audioSeconds: payload?.audioSeconds 
        });
        
        try {
            if (!payload || !(payload as any).audio || !payload.mime) {
                throw new Error('Invalid audio payload');
            }
            const raw = (payload as any).audio;
            let audio: Buffer | null = null;
            try {
                if (Buffer.isBuffer(raw)) {
                    audio = raw as Buffer;
                } else if (raw && typeof raw === 'object' && (raw as any).type === 'Buffer' && Array.isArray((raw as any).data)) {
                    audio = Buffer.from((raw as any).data);
                } else if (raw instanceof Uint8Array) {
                    audio = Buffer.from(raw);
                } else if (raw instanceof ArrayBuffer) {
                    audio = Buffer.from(new Uint8Array(raw));
                } else {
                    if (raw && typeof (raw as any).byteLength === 'number' && typeof (raw as any).slice === 'function') {
                        const view = new Uint8Array(raw as ArrayBufferLike);
                        audio = Buffer.from(view);
                    }
                }
            } catch (convErr) {
                try {
                    console.error('[main.assistant:transcribe] audio convert error:', convErr);
                } catch {
                }
            }
            if (!audio || !Buffer.isBuffer(audio) || audio.length === 0) throw new Error('Empty audio');
            const MAX_BYTES = 25 * 1024 * 1024;
            if (audio.length > MAX_BYTES) throw new Error('Audio is too large (>25MB)');
            const filename = payload.filename || 'lastN.webm';

            logger.info('stt', 'Starting transcription', { 
                audioSize: audio.length, 
                filename, 
                mime: payload.mime,
                audioSeconds: payload.audioSeconds 
            });

            const {text} = await transcribeAudioOnly(audio, filename, payload.mime, payload.audioSeconds);
            
            logger.info('stt', 'Transcription completed', { 
                textLength: text?.length || 0 
            });
            
            return {ok: true, text};
        } catch (err: any) {
            const formattedError = formatError(err);
            logger.error('stt', 'Transcription failed', { error: formattedError.displayText });
            return {ok: false, error: formattedError.displayText};
        }
    });

    ipcMain.handle(IPCChannels.AssistantAskChat, async (event, payload: AskChatRequest): Promise<void> => {
        logger.info('chat', 'Chat request received', { 
            textLength: payload?.text?.length || 0,
            requestId: payload?.requestId 
        });
        
        try {
            if (!payload || !payload.text) {
                throw new Error('Пустой текст для отправки');
            }
            const requestId = payload.requestId || 'default';

            logger.info('chat', 'Starting chat processing', { 
                textLength: payload.text.length,
                requestId 
            });

            event.sender.send(IPCChannels.AssistantStreamTranscript, {requestId, delta: ''});
            let accumulated = '';
            const ac = new AbortController();
            controllers.set(requestId, { controller: ac, cancelled: false, sentDone: false });
            const ctx = controllers.get(requestId)!;
            await askChatWithText(
                payload.text,
                (delta) => {
                    if (ctx.cancelled) return;
                    accumulated += delta;
                    event.sender.send(IPCChannels.AssistantStreamDelta, {requestId, delta});
                },
                () => {
                    if (ctx.sentDone) return;
                    ctx.sentDone = true;
                    event.sender.send(IPCChannels.AssistantStreamDone, {requestId, full: accumulated});
                },
                { signal: ac.signal, shouldCancel: () => controllers.get(requestId)?.cancelled === true }
            );
            
            logger.info('chat', 'Chat processing completed', { 
                responseLength: accumulated.length,
                requestId 
            });
            controllers.delete(requestId);
        } catch (err: any) {
            const formattedError = formatError(err);
            logger.error('chat', 'Chat processing failed', { 
                error: formattedError.displayText,
                requestId: (payload as any)?.requestId 
            });
            event.sender.send(IPCChannels.AssistantStreamError, {
                error: formattedError.displayText,
                requestId: (payload as any)?.requestId
            });
        }
    });

    ipcMain.handle(IPCChannels.AssistantStopStream, async (event, payload: StopStreamRequest): Promise<void> => {
        const requestId = payload?.requestId || 'default';
        const ctx = controllers.get(requestId);
        if (!ctx) return;
        try {
            ctx.cancelled = true;
            try { ctx.controller.abort(); } catch {}
            // Не шлём принудительно Done тут, чтобы не перетирать UI.
        } finally {
            // keep for a bit until stream loop exits; cleanup in handlers
        }
    });

    ipcMain.handle(IPCChannels.ScreenCapture, async (): Promise<ScreenCaptureResponse> => {
        try {
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: 1920, height: 1080 },
            });

            if (!sources.length) {
                throw new Error('No screen sources available');
            }

            let target = sources[0];
            try {
                const primary = screen.getPrimaryDisplay?.();
                if (primary) {
                    const primaryId = String(primary.id);
                    const match = sources.find((src) => src.display_id === primaryId);
                    if (match) target = match;
                }
            } catch {}

            if (!target || target.thumbnail.isEmpty()) {
                throw new Error('Failed to capture screen thumbnail');
            }

            const size = target.thumbnail.getSize();
            const png = target.thumbnail.toPNG();

            return {
                ok: true,
                base64: png.toString('base64'),
                width: size.width,
                height: size.height,
                mime: 'image/png',
            };
        } catch (error: any) {
            const formattedError = formatError(error);
            logger.error('screen', 'Screen capture failed', { error: formattedError.displayText });
            return { ok: false, error: formattedError.displayText };
        }
    });

    ipcMain.handle(IPCChannels.ScreenProcess, async (_event, payload: ScreenProcessRequest): Promise<ScreenProcessResponse> => {
        try {
            if (!payload || !payload.imageBase64) {
                throw new Error('Empty screenshot payload');
            }
            const buffer = Buffer.from(payload.imageBase64, 'base64');
            const mime = payload.mime && typeof payload.mime === 'string' ? payload.mime : 'image/png';
            const answer = await processScreenCapture(buffer, mime);
            logger.info('screen', 'Screen processing completed', {
                answerLength: answer?.length || 0,
            });
            return { ok: true, answer };
        } catch (error: any) {
            const formattedError = formatError(error);
            logger.error('screen', 'Screen processing failed', { error: formattedError.displayText });
            return { ok: false, error: formattedError.displayText };
        }
    });
}

