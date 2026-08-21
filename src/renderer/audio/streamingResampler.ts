function pcm16(sample: number): number {
    const clamped = Math.max(-1, Math.min(1, sample));
    return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

const LOW_PASS_TAPS = 127;

/**
 * Builds a linear-phase low-pass filter before decimation. The cutoff leaves a
 * small transition band below the destination Nyquist limit, which prevents
 * frequencies that the destination cannot represent from folding into speech.
 */
function createLowPass(sourceRate: number, targetRate: number): Float64Array | null {
    if (sourceRate <= targetRate) return null;

    const cutoff = (targetRate / sourceRate) * 0.45;
    const midpoint = (LOW_PASS_TAPS - 1) / 2;
    const coefficients = new Float64Array(LOW_PASS_TAPS);
    let sum = 0;

    for (let index = 0; index < LOW_PASS_TAPS; index += 1) {
        const distance = index - midpoint;
        const ideal = distance === 0
            ? 2 * cutoff
            : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
        // Blackman window: high stop-band attenuation without audible ringing.
        const window = 0.42
            - 0.5 * Math.cos((2 * Math.PI * index) / (LOW_PASS_TAPS - 1))
            + 0.08 * Math.cos((4 * Math.PI * index) / (LOW_PASS_TAPS - 1));
        coefficients[index] = ideal * window;
        sum += coefficients[index];
    }

    // Preserve DC gain exactly despite the finite/windowed impulse response.
    for (let index = 0; index < coefficients.length; index += 1) {
        coefficients[index] /= sum;
    }
    return coefficients;
}

/** Streaming speech resampler with stateful anti-alias filtering when downsampling. */
export class StreamingPcm16Resampler {
    private sourceRate = 0;
    private previousSample: number | null = null;
    private nextSourcePosition = 0;
    private lowPass: Float64Array | null = null;
    private lowPassHistory = new Float32Array();

    constructor(private readonly targetRate: number) {
        if (!Number.isFinite(targetRate) || targetRate < 8_000) {
            throw new Error('Invalid target sample rate');
        }
    }

    process(input: Float32Array, sourceRate: number): Int16Array {
        if (!input.length) return new Int16Array();
        const normalizedRate = Math.max(8_000, Math.floor(sourceRate || this.targetRate));
        if (this.sourceRate !== normalizedRate) this.reset(normalizedRate);

        const filteredInput = this.applyLowPass(input);

        const hasPrevious = this.previousSample !== null;
        const dataLength = filteredInput.length + (hasPrevious ? 1 : 0);
        const sampleAt = (index: number): number => {
            if (hasPrevious) {
                return index === 0 ? this.previousSample! : (filteredInput[index - 1] || 0);
            }
            return filteredInput[index] || 0;
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
        this.previousSample = filteredInput[filteredInput.length - 1] || 0;
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
        this.lowPass = sourceRate ? createLowPass(sourceRate, this.targetRate) : null;
        this.lowPassHistory = this.lowPass
            ? new Float32Array(this.lowPass.length - 1)
            : new Float32Array();
    }

    private applyLowPass(input: Float32Array): Float32Array {
        if (!this.lowPass) return input;

        const historyLength = this.lowPass.length - 1;
        const samples = new Float32Array(historyLength + input.length);
        samples.set(this.lowPassHistory);
        samples.set(input, historyLength);

        const output = new Float32Array(input.length);
        for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) {
            const newestIndex = historyLength + inputIndex;
            let filtered = 0;
            for (let tap = 0; tap < this.lowPass.length; tap += 1) {
                filtered += this.lowPass[tap] * samples[newestIndex - tap];
            }
            output[inputIndex] = filtered;
        }

        this.lowPassHistory.set(samples.subarray(samples.length - historyLength));
        return output;
    }
}
