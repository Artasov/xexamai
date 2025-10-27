export type StatusType = 'ready' | 'recording' | 'sending' | 'processing' | 'error';

let statusEl: HTMLDivElement | null = null;

export function initStatus(element: HTMLDivElement | null) {
    statusEl = element;
}

export function setStatus(text: string, type: StatusType = 'ready') {
    const target = statusEl ?? (document.getElementById('status') as HTMLDivElement | null);
    if (!target) return;
    statusEl = target;
    target.textContent = text;
    target.className = `status-badge ${type}`;
}
