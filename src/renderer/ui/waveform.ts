let activeCanvas: HTMLCanvasElement | null = null;

/** Registers the React-owned canvas used by the native level visualizer. */
export function registerWaveCanvas(canvas: HTMLCanvasElement): () => void {
    activeCanvas = canvas;
    return () => {
        if (activeCanvas === canvas) activeCanvas = null;
    };
}

export function getWaveCanvas(): HTMLCanvasElement | null {
    return activeCanvas;
}

