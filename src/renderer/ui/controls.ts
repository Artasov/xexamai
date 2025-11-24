import {setRecording, state} from '../state/appState';
import {setStatus} from './status';
import {logger} from '../utils/logger';
import {ensureTranscriptionReady} from '../utils/transcriptionGuards';

type ControlsInitArgs = {
    onRecordToggle: (shouldRecord: boolean) => Promise<void> | void;
    durations: number[];
    onDurationChange?: (sec: number) => void;
    onTextSend?: (text: string) => Promise<void> | void;
};

export function updateButtonsState() {
    const durationsEl = document.getElementById('durations') as HTMLDivElement | null;
    const btnRecord = document.getElementById('btnRecord') as HTMLButtonElement | null;
    const btnSendText = document.getElementById('btnSendText') as HTMLButtonElement | null;
    const btnScreenshot = document.getElementById('btnScreenshot') as HTMLButtonElement | null;
    const sendLastContainer = document.getElementById('send-last-container') as HTMLDivElement | null;
    const btnStop = document.getElementById('btnStopStream') as HTMLButtonElement | null;

    if (sendLastContainer) {
        if (state.isRecording) sendLastContainer.classList.add('expanded', 'mb-2');
        else sendLastContainer.classList.remove('expanded', 'mb-2');
    }

    if (durationsEl) {
        const buttons = durationsEl.querySelectorAll('button');
        buttons.forEach(btn => {
            // Duration buttons stay enabled even during processing to allow restart
            btn.disabled = false;
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
        });
    }

    if (btnRecord) {
        if (state.isProcessing) {
            btnRecord.disabled = true;
            btnRecord.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
            btnRecord.disabled = false;
            btnRecord.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }

    if (btnSendText) {
        if (state.isProcessing) {
            btnSendText.disabled = true;
            btnSendText.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
            btnSendText.disabled = false;
            btnSendText.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }

    if (btnScreenshot) {
        if (state.isProcessing) {
            btnScreenshot.disabled = true;
            btnScreenshot.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
            btnScreenshot.disabled = false;
            btnScreenshot.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }

    // Ensure Stop button is hidden whenever processing ends.
    // We do NOT force-show it here to avoid showing during non-streaming phases
    // like transcription or sending; showing is controlled explicitly in renderer.
    if (btnStop && !state.isProcessing) {
        btnStop.classList.add('hidden');
    }
}

export function updateDurations(durations: number[], onDurationChange?: (sec: number) => void) {
    const durationsEl = document.getElementById('durations') as HTMLDivElement | null;

    if (durationsEl) {
        durationsEl.innerHTML = '';
        durations.forEach((sec) => {
            const b = document.createElement('button');
            b.className = 'btn btn-secondary fcsc !px-1 !pb-1 !pt-0';
            b.textContent = `${sec}s`;
            b.dataset['sec'] = String(sec);
            b.addEventListener('click', () => {
                logger.info('ui', 'Duration button clicked', { duration: sec });
                setStatus(`Sending last ${sec}s...`, 'sending');
                onDurationChange?.(sec);
            });
            durationsEl.appendChild(b);
        });
    }
}

function initTextInput(onTextSend?: (text: string) => Promise<void> | void) {
    const textInput = document.getElementById('textInput') as HTMLTextAreaElement | null;
    const btnSendText = document.getElementById('btnSendText') as HTMLButtonElement | null;

    if (!textInput || !btnSendText) return;

    const updateSendButtonState = () => {
        const hasText = textInput.value.trim().length > 0;
        btnSendText.disabled = !hasText || state.isProcessing;
        if (state.isProcessing) {
            btnSendText.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
            btnSendText.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    };

    textInput.addEventListener('input', updateSendButtonState);
    textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (!btnSendText.disabled && onTextSend) {
                onTextSend(textInput.value.trim());
            }
        }
    });

    btnSendText.addEventListener('click', async () => {
        if (state.isProcessing || !onTextSend) return;

        const text = textInput.value.trim();
        if (!text) return;

        logger.info('ui', 'Send text button clicked', { textLength: text.length });
        await onTextSend(text);
    });

    updateSendButtonState();
}

export function initControls({onRecordToggle, durations, onDurationChange, onTextSend}: ControlsInitArgs) {
    const durationsEl = document.getElementById('durations') as HTMLDivElement | null;
    const btnRecord = document.getElementById('btnRecord') as HTMLButtonElement | null;
    const sendLastContainer = document.getElementById('send-last-container') as HTMLDivElement | null;

    updateDurations(durations, onDurationChange);

    initTextInput(onTextSend);

    if (sendLastContainer) {
        sendLastContainer.classList.remove('expanded');
    }

    btnRecord?.addEventListener('click', async () => {
        if (state.isProcessing) {
            return;
        }

        const shouldStart = !state.isRecording;
        if (shouldStart) {
            const ready = await ensureTranscriptionReady();
            if (!ready) {
                updateButtonsState();
                return;
            }
        }
        logger.info('ui', 'Record button clicked', { shouldStart });
        setRecording(shouldStart);
        btnRecord.disabled = true;
        let startedSuccessfully = false;
        try {
            await onRecordToggle(shouldStart);
            startedSuccessfully = true;
        } catch {
            setRecording(false);
            btnRecord.textContent = 'Start Audio Loop';
            btnRecord.dataset['state'] = 'idle';
        } finally {
            btnRecord.disabled = false;
            updateButtonsState();
        }

        if (!startedSuccessfully) {
            return;
        }

        btnRecord.textContent = shouldStart ? 'Stop' : 'Start Audio Loop';
        btnRecord.dataset['state'] = shouldStart ? 'rec' : 'idle';
        if (shouldStart) {
            try {
                const s = await window.api.settings.get();
                if ((s.streamMode || 'base') !== 'stream') {
                    setStatus('Recording...', 'recording');
                }
                // In stream mode, renderer will set a more specific status
            } catch {
                setStatus('Recording...', 'recording');
            }
        } else {
            setStatus('Ready', 'ready');
        }
    });
}
