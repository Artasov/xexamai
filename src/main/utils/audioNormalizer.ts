export function normalizeAudioInput(raw: unknown): Buffer | null {
    try {
        if (Buffer.isBuffer(raw)) {
            return raw;
        }
        if (raw && typeof raw === 'object' && (raw as any).type === 'Buffer' && Array.isArray((raw as any).data)) {
            return Buffer.from((raw as any).data);
        }
        if (raw instanceof Uint8Array) {
            return Buffer.from(raw);
        }
        if (raw instanceof ArrayBuffer) {
            return Buffer.from(new Uint8Array(raw));
        }
        if (raw && typeof (raw as any).byteLength === 'number' && typeof (raw as any).slice === 'function') {
            return Buffer.from(new Uint8Array(raw as ArrayBufferLike));
        }
    } catch (error) {
        console.error('[audioNormalizer] Failed to normalize audio input:', error);
    }
    return null;
}
