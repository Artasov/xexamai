import {ipcMain} from 'electron';
import {
    AskChatRequest,
    AssistantResponse,
    IPCChannels,
    SttProcessRequest,
    TranscribeOnlyRequest,
    StopStreamRequest
} from '../shared/types';
import {
    askChatWithText,
    processAudioToAnswer,
    processAudioToAnswerStream,
    transcribeAudioOnly
} from '../services/assistant.service';
import {logger} from '../services/logger.service';

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
                    // Попытка сконвертировать неизвестный тип
                    if (raw && typeof (raw as any).byteLength === 'number' && typeof (raw as any).slice === 'function') {
                        const view = new Uint8Array(raw as ArrayBufferLike);
                        audio = Buffer.from(view);
                    }
                }
            } catch (convErr) {
                try {
                    console.error('[main.assistant] audio convert error:', convErr);
                } catch {
                }
            }
            try {
                console.debug('[main.assistant] got audio length:', audio ? audio.length : 'not-buffer', 'mime:', payload.mime, 'filename:', payload.filename);
            } catch {
            }
            if (!audio || !Buffer.isBuffer(audio) || audio.length === 0) {
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
            const message = err?.message || String(err);
            logger.error('stt', 'Audio processing failed', { error: message });
            return {ok: false, error: message};
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
                    console.error('[main.assistant:stream] audio convert error:', convErr);
                } catch {
                }
            }
            if (!audio || !Buffer.isBuffer(audio) || audio.length === 0) throw new Error('Empty audio');
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
            const message = err?.message || String(err);
            logger.error('stt', 'Audio stream processing failed', { 
                error: message,
                requestId: (payload as any)?.requestId 
            });
            event.sender.send(IPCChannels.AssistantStreamError, {
                error: message,
                requestId: (payload as any)?.requestId
            });
            return {ok: false, error: message};
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
            const message = err?.message || String(err);
            logger.error('stt', 'Transcription failed', { error: message });
            return {ok: false, error: message};
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
            const message = err?.message || String(err);
            logger.error('chat', 'Chat processing failed', { 
                error: message,
                requestId: (payload as any)?.requestId 
            });
            event.sender.send(IPCChannels.AssistantStreamError, {
                error: message,
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
}

