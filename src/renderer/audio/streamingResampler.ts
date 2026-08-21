function pcm16(sample: number): number {
    const clamped = Math.max(-1, Math.min(1, sample));
    return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/** Linear resampler that carries both the boundary sample and fractional phase. */
export class StreamingPcm16Resampler {
    private sourceRate = 0;
    private previousSample: number | null = null;
    private nextSourcePosition = 0;

    constructor(private readonly targetRate: number) {
        if (!Number.isFinite(targetRate) || targetRate < 8_000) {
            throw new Error('Invalid target sample rate');
        }
    }

    process(input: Float32Array, sourceRate: number): Int16Array {
        if (!input.length) return new Int16Array();
        const normalizedRate = Math.max(8_000, Math.floor(sourceRate || this.targetRate));
        if (this.sourceRate !== normalizedRate) this.reset(normalizedRate);

        const hasPrevious = this.previousSample !== null;
        const dataLength = input.length + (hasPrevious ? 1 : 0);
        const sampleAt = (index: number): number => {
            if (hasPrevious) return index === 0 ? this.previousSample! : (input[index - 1] || 0);
            return input[index] || 0;
        };
        const step = this.sourceRate / this.targetRate;
        const output: number[] = [];

        // The final source sample is retained so interpolation across the next
        // native packet uses the real boundary rather than restarting phase.
        while (this.nextSourcePosition < dataLength - 1) {
            const first = Math.floor(this.nextSourcePosition);
            const second = Math.min(dataLength - 1, first + 1);
            const fraction = this.nextSourcePosition - first;
            const sample = sampleAt(first) + (sampleAt(second) - sampleAt(first)) * fraction;
            output.push(pcm16(sample));
            this.nextSourcePosition += step;
        }

        this.nextSourcePosition -= dataLength - 1;
        this.previousSample = input[input.length - 1] || 0;
        return Int16Array.from(output);
    }

    /** Pads only the sub-sample tail needed to preserve the captured duration. */
    finish(): Int16Array {
        if (this.previousSample === null || !this.sourceRate) return new Int16Array();
        const output: number[] = [];
        const step = this.sourceRate / this.targetRate;
        while (this.nextSourcePosition < 1 - 1e-9) {
            output.push(pcm16(this.previousSample));
            this.nextSourcePosition += step;
        }
        this.reset();
        return Int16Array.from(output);
    }

    reset(sourceRate = 0): void {
        this.sourceRate = sourceRate;
        this.previousSample = null;
        this.nextSourcePosition = 0;
    }
}
