export type StreamFrameMode = 'ndjson' | 'sse';

/** Incrementally frames UTF-8 text without dropping a final unterminated record. */
export class StreamFrameParser {
    private readonly mode: StreamFrameMode;
    private lineBuffer = '';
    private sseLines: string[] = [];

    constructor(mode: StreamFrameMode) {
        this.mode = mode;
    }

    push(text: string): string[] {
        this.lineBuffer += text;
        const frames: string[] = [];
        let newline = this.lineBuffer.indexOf('\n');
        while (newline >= 0) {
            let line = this.lineBuffer.slice(0, newline);
            this.lineBuffer = this.lineBuffer.slice(newline + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            this.consumeLine(line, frames);
            newline = this.lineBuffer.indexOf('\n');
        }
        return frames;
    }

    finish(text = ''): string[] {
        const frames = this.push(text);
        if (this.lineBuffer.length) {
            let line = this.lineBuffer;
            this.lineBuffer = '';
            if (line.endsWith('\r')) line = line.slice(0, -1);
            this.consumeLine(line, frames);
        }
        if (this.mode === 'sse') this.flushSse(frames);
        return frames;
    }

    private consumeLine(line: string, frames: string[]): void {
        if (this.mode === 'ndjson') {
            const value = line.trim();
            if (value) frames.push(value);
            return;
        }
        if (!line) {
            this.flushSse(frames);
            return;
        }
        if (line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) {
            return;
        }
        if (line.startsWith('data:')) {
            this.sseLines.push(line.slice(5).trimStart());
        }
    }

    private flushSse(frames: string[]): void {
        if (!this.sseLines.length) return;
        frames.push(this.sseLines.join('\n'));
        this.sseLines = [];
    }
}

export function decodeBase64Bytes(value: string): Uint8Array {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
}
