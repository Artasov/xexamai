export function ensureWave(): { wrap: HTMLDivElement; canvas: HTMLCanvasElement } {
    const existingWrap = document.getElementById('waveWrap') as HTMLDivElement | null;
    const existingCanvas = document.getElementById('waveCanvas') as HTMLCanvasElement | null;
    if (existingWrap && existingCanvas) return {wrap: existingWrap, canvas: existingCanvas};

    const waveformContainer = document.getElementById('waveform-container') as HTMLDivElement | null;
    if (!waveformContainer) {
        throw new Error('Waveform container not found');
    }

    const wrap = document.createElement('div');
    wrap.id = 'waveWrap';
    wrap.className = 'hidden h-10 bg-gray-700 rounded-md overflow-hidden border border-gray-600 flex-1';

    const canvas = document.createElement('canvas');
    canvas.id = 'waveCanvas';
    canvas.className = 'w-full h-full';
    wrap.appendChild(canvas);

    waveformContainer.appendChild(wrap);

    return {wrap, canvas};
}

export function showWave(wrap: HTMLElement) {
    wrap.classList.remove('hidden');
}

export function hideWave(wrap: HTMLElement) {
    wrap.classList.add('hidden');
}

