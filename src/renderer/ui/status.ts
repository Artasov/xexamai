const statusEl = document.getElementById('status') as HTMLDivElement | null;

export type StatusType = 'ready' | 'recording' | 'sending' | 'processing' | 'error';

export function setStatus(text: string, type: StatusType = 'ready') {
    if (statusEl) {
        statusEl.textContent = text;
        statusEl.className = `status-badge ${type}`;
    }
}

