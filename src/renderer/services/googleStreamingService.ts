import {settingsStore} from '../state/settingsStore';

type StreamOptions = {
    streamMode?: 'base' | 'stream';
};

export class GoogleStreamingService {
    private transcriptCallback: ((text: string) => void) | null = null;
    private errorCallback: ((error: string) => void) | null = null;
    private audioContext: AudioContext | null = null;
    private processor: ScriptProcessorNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;

    async start(stream: MediaStream, _options: StreamOptions = {}): Promise<void> {
        await this.stop();

        let settings;
        try {
            settings = settingsStore.get();
        } catch {
            settings = await settingsStore.load();
        }

        const apiKey = settings.googleApiKey;
        if (!apiKey) {
            throw new Error('Google API key not configured');
        }

        await window.api.google.startLive({
            apiKey,
            response: 'TEXT',
            transcribeInput: true,
            transcribeOutput: false,
        });

        window.api.google.onMessage((message: any) => {
            try {
                const inputTx = message?.serverContent?.inputTranscription?.text;
                const outputTx = message?.serverContent?.outputTranscription?.text;
                const plainText = message?.text;
                const text = inputTx || outputTx || plainText;
                if (text && typeof text === 'string') {
                    this.transcriptCallback?.(text);
                }
            } catch {
            }
        });

        window.api.google.onError((msg: string) => {
            this.errorCallback?.(msg || 'Google error');
        });

        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        this.source = this.audioContext.createMediaStreamSource(stream);
        this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

        let audioBuffer: Float32Array[] = [];

        this.processor.onaudioprocess = (event) => {
            const inputBuffer = event.inputBuffer;
            const inputData = inputBuffer.getChannelData(0);
            audioBuffer.push(new Float32Array(inputData));

            if (audioBuffer.length >= 20) {
                this.processAudioChunk(audioBuffer, this.audioContext!.sampleRate).catch((e) => {
                    try {
                        console.error('Google chunk error', e);
                    } catch {
                    }
                });
                audioBuffer = [];
            }
        };

        this.source.connect(this.processor);
        this.processor.connect(this.audioContext.destination);
    }

    async stop(): Promise<void> {
        try {
            await window.api.google.stopLive?.();
        } catch {
        }

        if (this.processor) {
            try {
                this.processor.disconnect();
            } catch {
            }
        }
        if (this.source) {
            try {
                this.source.disconnect();
            } catch {
            }
        }
        if (this.audioContext) {
            try {
                await this.audioContext.close();
            } catch {
            }
        }
        this.audioContext = null;
        this.processor = null;
        this.source = null;
    }

    onTranscript(callback: (text: string) => void): void {
        this.transcriptCallback = callback;
    }

    onError(callback: (error: string) => void): void {
        this.errorCallback = callback;
    }

    private async processAudioChunk(chunks: Float32Array[], sampleRate: number): Promise<void> {
        const combined = this.combineChunks(chunks);
        const pcm16 = this.float32ToPCM16Resampled(combined, Math.max(8000, Math.floor(sampleRate || 16000)), 16000);
        const audioBase64 = this.bytesToBase64(new Uint8Array(pcm16.buffer));
        await window.api.google.sendAudioChunk({
            data: audioBase64,
            mime: 'audio/pcm;rate=16000',
        });
    }

    private combineChunks(chunks: Float32Array[]): Float32Array {
        const totalLength = chunks.reduce((sum, buffer) => sum + buffer.length, 0);
        const combinedBuffer = new Float32Array(totalLength);
        let offset = 0;
        for (const buffer of chunks) {
            combinedBuffer.set(buffer, offset);
            offset += buffer.length;
        }
        return combinedBuffer;
    }

    private bytesToBase64(bytes: Uint8Array): string {
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
            binary += String.fromCharCode.apply(null, Array.from(sub) as unknown as number[]);
        }
        return btoa(binary);
    }

    private float32ToPCM16Resampled(input: Float32Array, inRate: number, outRate: number): Int16Array {
        const clampedInRate = Math.max(8000, Math.floor(inRate || 16000));
        const targetRate = Math.max(8000, Math.floor(outRate || 16000));
        if (clampedInRate === targetRate) {
            const out = new Int16Array(input.length);
            for (let i = 0; i < input.length; i++) {
                const s = Math.max(-1, Math.min(1, input[i] || 0));
                out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
            }
            return out;
        }
        const ratio = targetRate / clampedInRate;
        const outLen = Math.max(1, Math.floor(input.length * ratio));
        const out = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
            const t = i / ratio;
            const i0 = Math.floor(t);
            const i1 = Math.min(input.length - 1, i0 + 1);
            const frac = t - i0;
            const s0 = input[i0] || 0;
            const s1 = input[i1] || 0;
            const s = s0 + (s1 - s0) * frac;
            const ss = Math.max(-1, Math.min(1, s));
            out[i] = ss < 0 ? Math.round(ss * 0x8000) : Math.round(ss * 0x7fff);
        }
        return out;
    }
}
