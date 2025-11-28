// noinspection JSUnusedGlobalSymbols

let stopButton: HTMLButtonElement | null = null;

export function registerStopButton(button: HTMLButtonElement | null): void {
    stopButton = button;
}

export function getStopButton(): HTMLButtonElement | null {
    return stopButton;
}

export function showStopButton(): void {
    try {
        stopButton?.classList.remove('hidden');
    } catch {
    }
}

export function hideStopButton(): void {
    try {
        stopButton?.classList.add('hidden');
    } catch {
    }
}
