export type AppState = {
    isRecording: boolean;
    isProcessing: boolean; // блокировка во время распознавания и ответа
    durationSec: number; // capture window in seconds
    mime: string;
};

export const state: AppState = {
    isRecording: false,
    isProcessing: false,
    durationSec: 15,
    mime: 'audio/webm',
};

export function setDuration(sec: number) {
    state.durationSec = sec;
}

export function setRecording(v: boolean) {
    state.isRecording = v;
}

export function setProcessing(v: boolean) {
    state.isProcessing = v;
}

