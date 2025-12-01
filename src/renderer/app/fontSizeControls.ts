// noinspection JSUnusedGlobalSymbols

const FONT_SIZE_KEY = 'xexamai-answer-font-size';
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 14;

let wheelListenerAttached = false;

export function setupAnswerFontSizeControls(): void {
    initializeFontSize();
    attachWheelListener();
}

export function detachAnswerFontSizeControls(): void {
    if (!wheelListenerAttached) return;
    document.removeEventListener('wheel', handleFontSizeWheel);
    wheelListenerAttached = false;
}

function attachWheelListener(): void {
    if (wheelListenerAttached) return;
    document.addEventListener('wheel', handleFontSizeWheel, {passive: false});
    wheelListenerAttached = true;
}

function getCurrentFontSize(): number {
    const saved = localStorage.getItem(FONT_SIZE_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_FONT_SIZE;
}

function setFontSize(size: number, showNotification: boolean = true): void {
    const clampedSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
    localStorage.setItem(FONT_SIZE_KEY, clampedSize.toString());
    document.documentElement.style.setProperty('--answer-font-size', `${clampedSize}px`);

    if (showNotification) {
        showFontSizeNotification(clampedSize);
    }
}

function showFontSizeNotification(size: number): void {
    const existing = document.getElementById('font-size-notification');
    if (existing) {
        existing.remove();
    }

    const notification = document.createElement('div');
    notification.id = 'font-size-notification';
    notification.textContent = `Font size: ${size}px`;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 8px 16px;
        border-radius: 4px;
        font-size: 12px;
        z-index: 10000;
        pointer-events: none;
        transition: opacity 0.3s ease;
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
    }, 2000);
}

function initializeFontSize(): void {
    const currentSize = getCurrentFontSize();
    setFontSize(currentSize, false);
}

function handleFontSizeWheel(event: WheelEvent): void {
    if (!event.ctrlKey) return;

    event.preventDefault();

    const currentSize = getCurrentFontSize();
    const delta = event.deltaY > 0 ? -1 : 1;
    const newSize = currentSize + delta;

    setFontSize(newSize, true);
}
