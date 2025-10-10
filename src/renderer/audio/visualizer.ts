export type VisualizerOptions = {
    bars?: number; // number of bars to display
    smoothing?: number; // 0..1 analyser smoothing
};

export class AudioVisualizer {
    private ctx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private rafId: number | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private history: number[] = [];
    private maxBars = 64;
    private smoothing = 0.7;

    start(stream: MediaStream, canvas: HTMLCanvasElement, opts: VisualizerOptions = {}) {
        this.stop();
        this.canvas = canvas;
        this.maxBars = Math.max(16, Math.min(160, opts.bars ?? this.maxBars));
        this.smoothing = Math.max(0, Math.min(1, opts.smoothing ?? this.smoothing));

        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = this.smoothing;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -10;

        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);

        this.ctx = ctx;
        this.analyser = analyser;
        this.source = source;
        this.history = [];

        this.loop();
    }

    stop() {
        if (this.rafId != null) cancelAnimationFrame(this.rafId);
        this.rafId = null;
        if (this.source) {
            try {
                this.source.disconnect();
            } catch {
            }
        }
        if (this.analyser) {
            try {
                this.analyser.disconnect();
            } catch {
            }
        }
        if (this.ctx) {
            try {
                this.ctx.close();
            } catch {
            }
        }
        if (this.canvas) {
            const ctx2d = this.canvas.getContext('2d');
            if (ctx2d) {
                ctx2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
            }
        }
        this.ctx = null;
        this.analyser = null;
        this.source = null;
    }

    private loop = () => {
        if (!this.analyser || !this.canvas) return;

        const a = this.analyser;
        const buf = new Uint8Array(a.fftSize);
        a.getByteTimeDomainData(buf);

        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const gain = 1.6;
        const floor = 0.06;
        const level = Math.max(floor, Math.min(1, rms * gain));

        this.history.push(level);
        if (this.history.length > this.maxBars) this.history.shift();

        this.draw();
        this.rafId = requestAnimationFrame(this.loop);
    };

    private draw() {
        if (!this.canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const cssW = this.canvas.clientWidth || 1;
        const cssH = this.canvas.clientHeight || 1;
        if (this.canvas.width !== Math.floor(cssW * dpr) || this.canvas.height !== Math.floor(cssH * dpr)) {
            this.canvas.width = Math.floor(cssW * dpr);
            this.canvas.height = Math.floor(cssH * dpr);
        }

        const ctx = this.canvas.getContext('2d');
        if (!ctx) return;
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, cssW, cssH);

        const bars = this.history;
        const n = bars.length;
        const maxN = this.maxBars;
        const width = cssW;
        const height = cssH;
        const mid = height / 2;
        const gap = 2;
        const barW = Math.max(2, Math.floor(width / maxN) - gap);

        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(width, mid);
        ctx.stroke();

        ctx.fillStyle = 'rgba(147, 51, 234, 0.7)';
        const totalBarWidth = n * (barW + gap) - gap;
        const startX = Math.max(0, (width - totalBarWidth) / 2);

        for (let i = 0; i < n; i++) {
            const amp = bars[i];
            const x = startX + i * (barW + gap);
            if (x >= width) break;
            const h = Math.max(2, Math.min(height * 0.9, amp * height));
            const y = mid - h / 2;
            const r = Math.min(4, barW / 2, h / 2);
            this.roundRect(ctx, x, y, barW, h, r);
            ctx.fill();
        }

        ctx.restore();
    }

    private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }
}

