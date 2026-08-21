import {onAudioChunk, type AudioChunk} from './nativeAudio';
import {beginNativeRendererActivity} from '../state/rendererActivity';
import {StreamingPcm16Resampler} from '../audio/streamingResampler';

type StreamOptions = {
    streamMode?: 'base' | 'stream';
};

const TARGET_SAMPLE_RATE = 16_000;
const MIN_SEND_SAMPLES = 1_600;

/** Feeds the rolling native capture to Gemini Live without opening a second device. */
export class GoogleStreamingService {
    private transcriptCallback: ((text: string) => void) | null = null;
    private errorCallback: ((error: string) => void) | null = null;
    private audioUnsubscribe: (() => void) | null = null;
    private messageUnsubscribe: (() => void) | null = null;
    private errorUnsubscribe: (() => void) | null = null;
    private bufferedSamples: Int16Array[] = [];
    private bufferedLength = 0;
    private active = false;
    private releaseActivity: (() => Promise<void>) | null = null;
    private readonly resampler = new StreamingPcm16Resampler(TARGET_SAMPLE_RATE);

    async start(_stream?: MediaStream | null, _options: StreamOptions = {}): Promise<void> {
        await this.stop();
        const capability = await window.api.google.getLiveCapability();
        if (!capability.supported || !capability.configured) {
            throw new Error(capability.reason || 'Configure a Google AI API key to use realtime transcription.');
        }

        this.messageUnsubscribe = window.api.google.onMessage((message: any) => {
            const inputText = message?.serverContent?.inputTranscription?.text;
            if (typeof inputText === 'string' && inputText.trim()) {
                this.transcriptCallback?.(inputText.trim());
            }
        });
        this.errorUnsubscribe = window.api.google.onError((message: string) => {
            this.errorCallback?.(message || 'Google Live error');
        });

        try {
            this.releaseActivity = await beginNativeRendererActivity('Realtime transcription');
            await window.api.google.startLive({
                response: 'AUDIO',
                transcribeInput: true,
                transcribeOutput: false,
            });
            this.resampler.reset();
            this.active = true;
            this.audioUnsubscribe = onAudioChunk((chunk) => this.handleNativeAudio(chunk));
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    async stop(): Promise<void> {
        // Deliver a short final fragment before signalling audioStreamEnd.
        if (this.active) {
            this.enqueueAudio(this.resampler.finish());
            this.flushAudio();
        } else {
            this.resampler.reset();
        }
        this.active = false;
        this.audioUnsubscribe?.();
        this.audioUnsubscribe = null;
        try {
            await window.api.google.stopLive();
        } catch {
        }
        this.messageUnsubscribe?.();
        this.messageUnsubscribe = null;
        this.errorUnsubscribe?.();
        this.errorUnsubscribe = null;
        await this.releaseActivity?.();
        this.releaseActivity = null;
        this.bufferedSamples = [];
        this.bufferedLength = 0;
    }

    onTranscript(callback: (text: string) => void): void {
        this.transcriptCallback = callback;
    }

    onError(callback: (error: string) => void): void {
        this.errorCallback = callback;
    }

    private handleNativeAudio(chunk: AudioChunk): void {
        if (!this.active || !chunk.samples.length) return;
        const pcm = this.resampler.process(
            this.mixToMono(chunk.samples),
            chunk.sampleRate,
        );
        this.enqueueAudio(pcm);
        if (this.bufferedLength >= MIN_SEND_SAMPLES) this.flushAudio();
    }

    private enqueueAudio(pcm: Int16Array): void {
        if (!pcm.length) return;
        this.bufferedSamples.push(pcm);
        this.bufferedLength += pcm.length;
    }

    private flushAudio(): void {
        if (!this.bufferedLength || !this.active) return;
        const combined = new Int16Array(this.bufferedLength);
        let offset = 0;
        for (const chunk of this.bufferedSamples) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }
        this.bufferedSamples = [];
        this.bufferedLength = 0;
        const bytes = new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
        window.api.google.sendAudioChunk({
            data: this.bytesToBase64(bytes),
            mime: `audio/pcm;rate=${TARGET_SAMPLE_RATE}`,
        });
    }

    private mixToMono(channels: Float32Array[]): Float32Array {
        if (channels.length === 1) return channels[0];
        const length = Math.min(...channels.map((channel) => channel.length));
        const mixed = new Float32Array(Math.max(0, length));
        for (let i = 0; i < mixed.length; i++) {
            let value = 0;
            for (const channel of channels) value += channel[i] || 0;
            mixed[i] = value / channels.length;
        }
        return mixed;
    }

    private bytesToBase64(bytes: Uint8Array): string {
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
        }
        return btoa(binary);
    }

}
