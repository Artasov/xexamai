import {StreamingPcm16Resampler} from '../audio/streamingResampler';
import {beginNativeRendererActivity} from '../state/rendererActivity';
import {onAudioChunk, type AudioChunk} from './nativeAudio';
import {
    OpenAiTranscriptAssembler,
    OpenAiTranslationTranscriptAssembler,
    type OpenAiTranscriptAcknowledgement,
    type OpenAiTranslationAcknowledgement,
    type OpenAiTranslationTranscript,
} from './openAiLiveContract';

const TARGET_SAMPLE_RATE = 24_000;
// 40 ms at 24 kHz, matching the low-latency packet cadence used by Google Live.
const MIN_SEND_SAMPLES = 960;
// Realtime Translation consumes 200 ms engine frames.
const TRANSLATION_SEND_SAMPLES = 4_800;
const MAX_SETUP_BUFFER_SAMPLES = TARGET_SAMPLE_RATE * 10;

type OpenAiStreamOptions = {
    prompt?: string;
    targetLanguage?: string;
};

export type OpenAiRealtimeAcknowledgement = {
    generation: number;
    transcript: OpenAiTranscriptAcknowledgement;
    translation: OpenAiTranslationAcknowledgement;
};

/** Feeds native capture into the dedicated OpenAI realtime transcription API. */
export class OpenAiStreamingService {
    private transcriptCallback: ((text: string) => void) | null = null;
    private translationCallback: ((text: OpenAiTranslationTranscript) => void) | null = null;
    private translationTurnCompletedCallback: (() => void) | null = null;
    private readonly translationTurnWaiters = new Set<() => void>();
    private errorCallback: ((error: string) => void) | null = null;
    private audioUnsubscribe: (() => void) | null = null;
    private messageUnsubscribe: (() => void) | null = null;
    private errorUnsubscribe: (() => void) | null = null;
    private bufferedSamples: Int16Array[] = [];
    private bufferedLength = 0;
    private active = false;
    private transportReady = false;
    private releaseActivity: (() => Promise<void>) | null = null;
    private readonly resampler = new StreamingPcm16Resampler(TARGET_SAMPLE_RATE);
    private readonly transcripts = new OpenAiTranscriptAssembler();
    private readonly translations = new OpenAiTranslationTranscriptAssembler();
    private translationMode = false;
    private sessionGeneration = 0;

    async start(options: OpenAiStreamOptions = {}): Promise<void> {
        const reconnectBuffer = !this.transportReady ? [...this.bufferedSamples] : [];
        const reconnectLength = reconnectBuffer.reduce((total, chunk) => total + chunk.length, 0);
        await this.stop();
        this.bufferedSamples = reconnectBuffer;
        this.bufferedLength = reconnectLength;

        const capability = await window.api.openai.getLiveCapability();
        if (!capability.supported || !capability.configured) {
            throw new Error(capability.reason || 'Configure an OpenAI API key to use realtime transcription.');
        }

        this.messageUnsubscribe = window.api.openai.onMessage((message) => {
            if (this.translationMode) {
                const text = this.translations.apply(message);
                if (text && (text.source.trim() || text.translated.trim())) {
                    try {
                        this.translationCallback?.(text);
                    } catch {
                    }
                }
                if (this.translations.consumeOutputBoundary()) {
                    this.notifyTranslationTurnCompleted();
                }
                return;
            }
            const failed = message.type === 'conversation.item.input_audio_transcription.failed';
            if (failed) {
                const detail = typeof message.error?.message === 'string'
                    ? message.error.message
                    : 'OpenAI could not transcribe an audio segment.';
                this.errorCallback?.(detail);
                return;
            }
            const text = this.transcripts.apply(message);
            if (text?.trim()) this.transcriptCallback?.(text);
        });
        this.errorUnsubscribe = window.api.openai.onError((message) => {
            this.transportReady = false;
            this.errorCallback?.(message || 'OpenAI Realtime error');
        });

        try {
            this.releaseActivity = await beginNativeRendererActivity('Realtime transcription');
            this.resampler.reset();
            this.transcripts.reset();
            this.translations.reset();
            this.translationMode = Boolean(options.targetLanguage);
            this.active = true;
            this.transportReady = false;
            this.audioUnsubscribe = onAudioChunk((chunk) => this.handleNativeAudio(chunk));
            await window.api.openai.startLive({
                prompt: options.prompt,
                targetLanguage: options.targetLanguage,
            });
            this.transportReady = true;
            this.flushAudio();
        } catch (error) {
            // Keep the native-audio subscription and bounded setup buffer
            // alive across controller backoff. A later start() snapshots that
            // buffer before replacing the failed transport. If startup failed
            // before capture/activity ownership was established, clean up in
            // full instead.
            this.transportReady = false;
            if (!this.active || !this.audioUnsubscribe || !this.releaseActivity) {
                await this.stop();
            } else {
                try {
                    await window.api.openai.stopLive();
                } catch {
                }
            }
            throw error;
        }
    }

    captureAcknowledgement(): OpenAiRealtimeAcknowledgement {
        return {
            generation: this.sessionGeneration,
            transcript: this.transcripts.captureAcknowledgement(),
            translation: this.translations.captureAcknowledgement(),
        };
    }

    acknowledgeTranscript(
        acknowledgement: OpenAiRealtimeAcknowledgement = this.captureAcknowledgement(),
    ): boolean {
        if (acknowledgement.generation !== this.sessionGeneration) return false;
        this.transcripts.acknowledge(acknowledgement.transcript);
        this.translations.acknowledge(acknowledgement.translation);
        return true;
    }

    /** Commits the current manual transcription turn without stopping capture. */
    async finalizeTurn(): Promise<void> {
        if (this.translationMode) {
            // Translation owns its continuous server-side turn detection. The
            // bridge method is intentionally a no-op for this mode, but keep a
            // single service entry point for callers switching between modes.
            await window.api.openai.commitLiveTurn();
            return;
        }
        if (!this.active || !this.transportReady) {
            throw new Error('OpenAI Realtime is reconnecting; the current turn is not final yet.');
        }
        this.enqueueAudio(this.resampler.finish());
        this.flushAudio();
        await window.api.openai.commitLiveTurn();
    }

    isTranslationOutputComplete(): boolean {
        return this.translationMode && this.translations.isOutputCompleted();
    }

    waitForTranslationTurnCompleted(timeoutMs = 1_200): Promise<void> {
        if (this.isTranslationOutputComplete()) return Promise.resolve();
        return new Promise((resolve) => {
            let settled = false;
            const resolveOnce = () => {
                if (settled) return;
                settled = true;
                globalThis.clearTimeout(timer);
                this.translationTurnWaiters.delete(resolveOnce);
                resolve();
            };
            const timer = globalThis.setTimeout(resolveOnce, Math.max(0, timeoutMs));
            this.translationTurnWaiters.add(resolveOnce);
            // Keep the waiter race-free if a caller checks immediately after
            // the completed event was applied.
            if (this.isTranslationOutputComplete()) resolveOnce();
        });
    }

    async stop(): Promise<void> {
        // Invalidate acknowledgement snapshots synchronously. A manual send
        // can overlap a reconnect, and a watermark from the previous socket
        // must never consume text from the replacement session.
        this.sessionGeneration += 1;
        if (this.active) {
            this.enqueueAudio(this.resampler.finish());
            this.flushAudio();
        } else {
            this.resampler.reset();
        }
        this.active = false;
        this.transportReady = false;
        this.audioUnsubscribe?.();
        this.audioUnsubscribe = null;
        try {
            await window.api.openai.stopLive();
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
        this.transcripts.reset();
        this.translations.reset();
        this.translationMode = false;
        this.resolveTranslationTurnWaiters();
    }

    onTranscript(callback: (text: string) => void): void {
        this.transcriptCallback = callback;
    }

    onTranslation(callback: (text: OpenAiTranslationTranscript) => void): void {
        this.translationCallback = callback;
    }

    onTranslationTurnCompleted(callback: () => void): void {
        this.translationTurnCompletedCallback = callback;
    }

    onError(callback: (error: string) => void): void {
        this.errorCallback = callback;
    }

    private notifyTranslationTurnCompleted(): void {
        try {
            this.translationTurnCompletedCallback?.();
        } catch {
        }
        this.resolveTranslationTurnWaiters();
    }

    private resolveTranslationTurnWaiters(): void {
        for (const resolve of this.translationTurnWaiters) resolve();
        this.translationTurnWaiters.clear();
    }

    private handleNativeAudio(chunk: AudioChunk): void {
        if (!this.active || !chunk.samples.length) return;
        const pcm = this.resampler.process(this.mixToMono(chunk.samples), chunk.sampleRate);
        this.enqueueAudio(pcm);
        const sendThreshold = this.translationMode ? TRANSLATION_SEND_SAMPLES : MIN_SEND_SAMPLES;
        if (this.transportReady && this.bufferedLength >= sendThreshold) this.flushAudio();
    }

    private enqueueAudio(pcm: Int16Array): void {
        if (!pcm.length) return;
        this.bufferedSamples.push(pcm);
        this.bufferedLength += pcm.length;
        if (!this.transportReady && this.bufferedLength > MAX_SETUP_BUFFER_SAMPLES) {
            let excess = this.bufferedLength - MAX_SETUP_BUFFER_SAMPLES;
            while (excess > 0 && this.bufferedSamples.length) {
                const first = this.bufferedSamples[0];
                if (first.length <= excess) {
                    this.bufferedSamples.shift();
                    this.bufferedLength -= first.length;
                    excess -= first.length;
                } else {
                    this.bufferedSamples[0] = first.subarray(excess);
                    this.bufferedLength -= excess;
                    excess = 0;
                }
            }
        }
    }

    private flushAudio(): void {
        if (!this.bufferedLength || !this.active || !this.transportReady) return;
        const combined = new Int16Array(this.bufferedLength);
        let offset = 0;
        for (const chunk of this.bufferedSamples) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }
        this.bufferedSamples = [];
        this.bufferedLength = 0;
        const bytes = new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
        window.api.openai.sendAudioChunk({data: this.bytesToBase64(bytes)});
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
