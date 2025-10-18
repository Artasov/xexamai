import {AssistantAPI} from '../../shared/ipc';

let GoogleGenAIClass: any = null;
let GenaiModality: any = null;

async function ensureGenAI() {
    if (GoogleGenAIClass && GenaiModality) return;
    const mod = await import('@google/genai');
    GoogleGenAIClass = mod.GoogleGenAI || (mod as any).default?.GoogleGenAI || mod;
    GenaiModality = mod.Modality;
}

export function createGeminiBridge(): AssistantAPI['gemini'] {
    let liveSession: any = null;
    let onMessageCb: ((message: any) => void) | null = null;
    let onErrorCb: ((error: string) => void) | null = null;

    async function startLive(opts: { apiKey: string; response: 'TEXT' | 'AUDIO'; transcribeInput?: boolean; transcribeOutput?: boolean }) {
        if (liveSession) {
            try {
                liveSession.close?.();
            } catch {
            }
            liveSession = null;
        }
        await ensureGenAI();
        const ai = new GoogleGenAIClass({ apiKey: opts.apiKey });
        const model = 'gemini-live-2.5-flash-preview';
        const config: any = {
            responseModalities: [opts.response === 'AUDIO' ? GenaiModality.AUDIO : GenaiModality.TEXT],
        };
        if (opts.transcribeInput) config.inputAudioTranscription = {};
        if (opts.transcribeOutput) config.outputAudioTranscription = {};

        liveSession = await ai.live.connect({
            model,
            config,
            callbacks: {
                onopen: () => {},
                onmessage: (message: any) => {
                    try {
                        onMessageCb?.(message);
                    } catch {
                    }
                },
                onerror: (e: any) => {
                    try {
                        onErrorCb?.(e?.message || 'Gemini error');
                    } catch {
                    }
                },
                onclose: () => {},
            },
        });
    }

    function sendAudioChunk(params: { data: string; mime: string }) {
        if (!liveSession) throw new Error('Gemini Live session not started');
        liveSession.sendRealtimeInput({
            audio: {
                data: params.data,
                mimeType: params.mime,
            },
        });
    }

    function stopLive() {
        try {
            liveSession?.close?.();
        } catch {
        }
        liveSession = null;
    }

    function onMessage(cb: (message: any) => void) {
        onMessageCb = cb;
    }

    function onError(cb: (error: string) => void) {
        onErrorCb = cb;
    }

    return {
        startLive,
        sendAudioChunk,
        stopLive,
        onMessage,
        onError,
    };
}
