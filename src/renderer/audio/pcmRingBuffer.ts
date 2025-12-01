export type PcmChunk = {
    t: number; // Date.now ms
    frames: number;
    data: Float32Array[]; // per-channel, same length
};

export class PcmRingBuffer {
    private chunks: PcmChunk[] = [];
    private maxMs: number;
    private sampleRate: number;
    private readonly channels: number;

    constructor(sampleRate: number, channels: number, maxSeconds: number) {
        this.sampleRate = sampleRate;
        this.channels = Math.max(1, channels | 0);
        this.maxMs = Math.max(1, maxSeconds) * 1000;
    }

    // noinspection JSUnusedGlobalSymbols
    setWindowSeconds(sec: number) {
        this.maxMs = Math.max(1, sec) * 1000;
        this.compact();
    }

    push(channelData: Float32Array[], frames: number, sampleRate?: number) {
        if (!Array.isArray(channelData) || channelData.length === 0 || frames <= 0) return;
        if (sampleRate && sampleRate > 1000) {
            this.sampleRate = sampleRate;
        }
        const now = Date.now();
        const copied = channelData.map((arr) => {
            if (arr.length === frames) {
                return new Float32Array(arr);
            }
            const out = new Float32Array(frames);
            out.set(arr.subarray(0, frames));
            return out;
        });
        this.chunks.push({t: now, frames, data: copied});
        this.compact();
    }

    private compact() {
        const now = Date.now();
        const cutoff = now - this.maxMs;
        while (this.chunks.length && this.chunks[0].t < cutoff) {
            this.chunks.shift();
        }
        while (this.totalMs() > this.maxMs * 1.2 && this.chunks.length > 1) {
            this.chunks.shift();
        }
    }

    private totalMs() {
        const totalFrames = this.chunks.reduce((s, c) => s + c.frames, 0);
        return (totalFrames / this.sampleRate) * 1000;
    }

    getLastSecondsFloats(seconds: number): { channels: Float32Array[]; sampleRate: number } | null {
        if (!this.chunks.length) return null;
        const needFrames = Math.max(1, Math.floor(seconds * this.sampleRate));
        let accFrames = 0;
        const picks: PcmChunk[] = [];
        for (let i = this.chunks.length - 1; i >= 0; i--) {
            const c = this.chunks[i];
            accFrames += c.frames;
            picks.push(c);
            if (accFrames >= needFrames) break;
        }
        if (!picks.length) return null;
        picks.reverse();

        const totalFrames = Math.min(accFrames, needFrames);
        const out: Float32Array[] = new Array(this.channels).fill(null).map(() => new Float32Array(totalFrames));

        let writeOffset = 0;
        for (const c of picks) {
            const toCopy = Math.min(c.frames, totalFrames - writeOffset);
            for (let ch = 0; ch < this.channels; ch++) {
                out[ch].set(c.data[ch].subarray(0, toCopy), writeOffset);
            }
            writeOffset += toCopy;
            if (writeOffset >= totalFrames) break;
        }
        return {channels: out, sampleRate: this.sampleRate};
    }
}
