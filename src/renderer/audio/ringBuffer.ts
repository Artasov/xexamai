// noinspection JSUnusedGlobalSymbols

export type AudioChunk = {
    t: number; // timestamp ms (Date.now)
    blob: Blob;
    ms: number; // approx duration ms of this chunk
};

export class AudioRingBuffer {
    private chunks: AudioChunk[] = [];
    private maxMs: number;

    constructor(maxSeconds: number) {
        this.maxMs = maxSeconds * 1000;
    }

    // noinspection JSUnusedGlobalSymbols
    setWindowSeconds(sec: number) {
        this.maxMs = sec * 1000;
        this.compact();
    }

    push(chunk: AudioChunk) {
        try {
            console.debug('[ringBuffer.push] chunk:', {size: chunk?.blob?.size, ms: chunk?.ms, t: chunk?.t});
        } catch {
        }
        if (!chunk || !(chunk.blob instanceof Blob) || chunk.blob.size === 0 || !Number.isFinite(chunk.ms) || chunk.ms <= 0) {
            try {
                console.warn('[ringBuffer.push] skip empty or invalid chunk', {size: chunk?.blob?.size, ms: chunk?.ms});
            } catch {
            }
            return;
        }
        this.chunks.push(chunk);
        try {
            console.debug('[ringBuffer.push] after push - chunks:', this.chunks.length, 'totalMs:', this.totalMs());
        } catch {
        }
        this.compact();
        try {
            console.debug('[ringBuffer.push] after compact - chunks:', this.chunks.length, 'totalMs:', this.totalMs());
        } catch {
        }
    }

    private compact() {
        const now = Date.now();
        const cutoff = now - this.maxMs;
        const beforeCount = this.chunks.length;
        while (this.chunks.length && this.chunks[0].t < cutoff) {
            const removed = this.chunks.shift();
            try {
                console.debug('[ringBuffer.compact] removed old chunk:', {
                    t: removed?.t,
                    age: now - (removed?.t || 0),
                    cutoff
                });
            } catch {
            }
        }
        let total = this.totalMs();
        while (this.chunks.length > 1 && total > this.maxMs * 1.2) {
            const first = this.chunks.shift();
            if (!first) break;
            total -= first.ms;
            try {
                console.debug('[ringBuffer.compact] trimmed excess chunk, remaining total:', total);
            } catch {
            }
        }
        try {
            console.debug('[ringBuffer.compact] before:', beforeCount, 'after:', this.chunks.length, 'maxMs:', this.maxMs, 'totalMs:', this.totalMs());
        } catch {
        }
    }

    totalMs() {
        return this.chunks.reduce((s, c) => s + c.ms, 0);
    }

    async getLastWindowBlob(mime = 'audio/webm'): Promise<Blob | null> {
        if (!this.chunks.length) return null;
        const parts = this.chunks
            .map((c) => c.blob)
            .filter((b) => b && b.size > 0);
        if (!parts.length) {
            try {
                console.warn('[ringBuffer.getLastWindowBlob] no non-empty parts');
            } catch {
            }
            return null;
        }
        const blob = new Blob(parts, {type: mime});
        try {
            console.debug('[ringBuffer.getLastWindowBlob] parts:', parts.length, 'size:', blob.size);
        } catch {
        }
        return blob;
    }

    async getLastSecondsBlob(seconds: number, mime = 'audio/webm'): Promise<Blob | null> {
        try {
            console.debug('[ringBuffer.getLastSecondsBlob] start - chunks:', this.chunks.length, 'totalMs:', this.totalMs(), 'needSeconds:', seconds);
        } catch {
        }
        if (!this.chunks.length) {
            try {
                console.warn('[ringBuffer.getLastSecondsBlob] no chunks available');
            } catch {
            }
            return null;
        }
        const needMs = Math.max(0, seconds * 1000);
        let acc = 0;
        const parts: Blob[] = [];
        for (let i = this.chunks.length - 1; i >= 0; i--) {
            const c = this.chunks[i];
            try {
                console.debug('[ringBuffer.getLastSecondsBlob] checking chunk', i, 'size:', c.blob?.size, 'ms:', c.ms);
            } catch {
            }
            if (!c.blob || c.blob.size === 0) continue;
            parts.push(c.blob);
            acc += c.ms;
            try {
                console.debug('[ringBuffer.getLastSecondsBlob] added chunk, acc:', acc, 'needMs:', needMs);
            } catch {
            }
            if (acc >= needMs) break;
        }
        if (parts.length === 0) {
            try {
                console.warn('[ringBuffer.getLastSecondsBlob] collected 0 parts for', seconds, 's');
            } catch {
            }
            return null;
        }
        parts.reverse();
        const blob = new Blob(parts, {type: mime});
        try {
            console.debug('[ringBuffer.getLastSecondsBlob] seconds:', seconds, 'parts:', parts.length, 'size:', blob.size, 'accMs:', acc);
        } catch {
        }
        return blob;
    }

    async getLastSecondsWavBlob(seconds: number): Promise<Blob | null> {
        try {
            console.debug('[ringBuffer.getLastSecondsWavBlob] start - chunks:', this.chunks.length, 'totalMs:', this.totalMs(), 'needSeconds:', seconds);
        } catch {
        }
        if (!this.chunks.length) return null;
        const needMs = Math.max(0, seconds * 1000);
        let acc = 0;
        const parts: Blob[] = [];
        for (let i = this.chunks.length - 1; i >= 0; i--) {
            const c = this.chunks[i];
            if (!c.blob || c.blob.size === 0) continue;
            parts.push(c.blob);
            acc += c.ms;
            if (acc >= needMs) break;
        }
        if (parts.length === 0) return null;
        parts.reverse();
        const mod = await import('./encoder');
        const wav = await (mod as any).blobsToWav(parts);
        try {
            console.debug('[ringBuffer.getLastSecondsWavBlob] parts:', parts.length, 'wav size:', wav.size);
        } catch {
        }
        return wav;
    }
}
