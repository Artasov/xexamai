export type PcmChunk = {
    frames: number;
    data: Float32Array[];
};

export type PcmWindow = {
    channels: Float32Array[];
    sampleRate: number;
    frames: number;
    durationSeconds: number;
    requestedSeconds: number;
};

/**
 * A frame-counted PCM ring. The output rate never changes after construction;
 * incoming native-device rates are converted before data enters the ring.
 */
export class PcmRingBuffer {
    private chunks: PcmChunk[] = [];
    private maxFrames: number;
    private totalFrames = 0;
    private readonly sampleRate: number;
    private readonly channels: number;

    private sourceRate: number | null = null;
    private resamplePosition = 0;
    private resampleBuffer: number[][];

    constructor(sampleRate: number, channels: number, maxSeconds: number) {
        this.sampleRate = positiveInteger(sampleRate, 48_000);
        this.channels = Math.max(1, channels | 0);
        this.maxFrames = secondsToFrames(maxSeconds, this.sampleRate);
        this.resampleBuffer = Array.from({length: this.channels}, () => []);
    }

    setWindowSeconds(seconds: number): void {
        this.maxFrames = secondsToFrames(seconds, this.sampleRate);
        this.compact();
    }

    push(channelData: Float32Array[], frames: number, sampleRate?: number): void {
        if (!Array.isArray(channelData) || channelData.length === 0) return;
        const declaredFrames = Math.max(0, Math.floor(frames));
        const availableFrames = Math.min(
            declaredFrames,
            ...channelData.filter(Boolean).map((channel) => channel.length),
        );
        if (availableFrames <= 0) return;

        const inputRate = positiveInteger(sampleRate, this.sampleRate);
        const normalized = normalizeChannels(channelData, availableFrames, this.channels);
        if (inputRate === this.sampleRate) {
            this.flushRateTransition();
            this.append(normalized, availableFrames);
            return;
        }

        if (this.sourceRate !== null && this.sourceRate !== inputRate) {
            this.flushRateTransition();
        }
        this.sourceRate = inputRate;
        for (let channel = 0; channel < this.channels; channel++) {
            const target = this.resampleBuffer[channel];
            const source = normalized[channel];
            for (let frame = 0; frame < availableFrames; frame++) {
                target.push(finiteSample(source[frame]));
            }
        }
        this.produceResampled(false);
    }

    availableDurationSeconds(): number {
        return this.totalFrames / this.sampleRate;
    }

    getLastSecondsFloats(seconds: number): PcmWindow | null {
        if (this.totalFrames === 0) return null;

        const requestedSeconds = positiveNumber(seconds, 1 / this.sampleRate);
        const requestedFrames = secondsToFrames(requestedSeconds, this.sampleRate);
        const outputFrames = Math.min(this.totalFrames, requestedFrames);
        const output = Array.from(
            {length: this.channels},
            () => new Float32Array(outputFrames),
        );

        let remaining = outputFrames;
        for (let chunkIndex = this.chunks.length - 1; chunkIndex >= 0 && remaining > 0; chunkIndex--) {
            const chunk = this.chunks[chunkIndex];
            const take = Math.min(chunk.frames, remaining);
            const sourceOffset = chunk.frames - take;
            const targetOffset = remaining - take;
            for (let channel = 0; channel < this.channels; channel++) {
                output[channel].set(
                    chunk.data[channel].subarray(sourceOffset, sourceOffset + take),
                    targetOffset,
                );
            }
            remaining -= take;
        }

        return {
            channels: output,
            sampleRate: this.sampleRate,
            frames: outputFrames,
            durationSeconds: outputFrames / this.sampleRate,
            requestedSeconds,
        };
    }

    private append(channelData: Float32Array[], frames: number): void {
        if (frames <= 0) return;
        const copied = channelData.map((channel) => {
            const output = new Float32Array(frames);
            output.set(channel.subarray(0, frames));
            return output;
        });
        this.chunks.push({frames, data: copied});
        this.totalFrames += frames;
        this.compact();
    }

    private compact(): void {
        let excess = this.totalFrames - this.maxFrames;
        while (excess > 0 && this.chunks.length > 0) {
            const first = this.chunks[0];
            if (excess >= first.frames) {
                excess -= first.frames;
                this.totalFrames -= first.frames;
                this.chunks.shift();
                continue;
            }

            first.data = first.data.map((channel) => channel.slice(excess));
            first.frames -= excess;
            this.totalFrames -= excess;
            excess = 0;
        }
    }

    private flushRateTransition(): void {
        if (this.sourceRate === null) return;
        this.produceResampled(true);
        this.sourceRate = null;
        this.resamplePosition = 0;
        this.resampleBuffer = Array.from({length: this.channels}, () => []);
    }

    private produceResampled(flush: boolean): void {
        if (this.sourceRate === null) return;
        const sourceFrames = this.resampleBuffer[0]?.length ?? 0;
        if (sourceFrames === 0) return;

        const step = this.sourceRate / this.sampleRate;
        const lastFrame = sourceFrames - 1;
        const output: number[][] = Array.from({length: this.channels}, () => []);
        while (flush ? this.resamplePosition <= lastFrame : this.resamplePosition + 1 <= lastFrame) {
            const base = Math.floor(this.resamplePosition);
            const next = Math.min(base + 1, lastFrame);
            const fraction = this.resamplePosition - base;
            for (let channel = 0; channel < this.channels; channel++) {
                const source = this.resampleBuffer[channel];
                output[channel].push(source[base] + (source[next] - source[base]) * fraction);
            }
            this.resamplePosition += step;
        }

        const outputFrames = output[0]?.length ?? 0;
        if (outputFrames > 0) {
            this.append(output.map((channel) => Float32Array.from(channel)), outputFrames);
        }
        if (flush) return;

        const consumed = Math.floor(this.resamplePosition);
        if (consumed > 0) {
            for (const channel of this.resampleBuffer) channel.splice(0, consumed);
            this.resamplePosition -= consumed;
        }
    }
}

function normalizeChannels(input: Float32Array[], frames: number, channels: number): Float32Array[] {
    const first = input[0];
    return Array.from({length: channels}, (_, channelIndex) => {
        const source = input[channelIndex] ?? first;
        const output = new Float32Array(frames);
        for (let frame = 0; frame < frames; frame++) output[frame] = finiteSample(source[frame]);
        return output;
    });
}

function secondsToFrames(seconds: number, sampleRate: number): number {
    return Math.max(1, Math.floor(positiveNumber(seconds, 1 / sampleRate) * sampleRate));
}

function positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && Number(value) > 0 ? Math.max(1, Math.floor(Number(value))) : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function finiteSample(value: number): number {
    return Number.isFinite(value) ? value : 0;
}
