import {initControls, updateDurations} from './ui/controls';
import {initStatus, setStatus} from './ui/status';
import {initOutputs} from './ui/outputs';
import {settingsStore} from './state/settingsStore';
import {initializeWelcomeModal} from './ui/welcomeModal';
import {setupAnswerFontSizeControls} from './app/fontSizeControls';
import {awaitPreloadBridge} from './app/preloadBridge';
import {StreamController} from './app/streamController';
import {ScreenshotController} from './app/screenshotController';
import {startLogoAnimation} from './ui/logoAnimation';
import {checkHolderAccess, showHolderOnlyModal} from './ui/holderOnlyModal';
import {registerStopButton, hideStopButton} from './ui/stopButton';
import {state} from './state/appState';

export async function initializeRenderer() {
    setupAnswerFontSizeControls();

    initStatus(document.getElementById('status') as HTMLDivElement | null);
    initOutputs({
        text: document.getElementById('textOut') as HTMLDivElement | null,
        answer: document.getElementById('answerOut') as HTMLDivElement | null,
    });

    const bridge = await awaitPreloadBridge();
    if (!bridge) {
        setStatus('Preload-скрипт недоступен', 'error');
        return;
    }
    console.info('[renderer] Preload bridge ready for use');

    const streamController = new StreamController();
    const screenshotController = new ScreenshotController();

    const streamModeContainer = document.getElementById('streamResultsSection');
    const streamResults = document.getElementById('streamResultsTextarea') as HTMLTextAreaElement | null;
    const btnSendStream = document.getElementById('btnSendStreamText') as HTMLButtonElement | null;
    const btnToggleInput = document.getElementById('btnToggleInput') as HTMLButtonElement | null;
    const toggleInputIcon = document.getElementById('toggleInputIcon') as HTMLImageElement | null;
    const durationsContainer = document.getElementById('send-last-container') as HTMLDivElement | null;
    streamController.initialize({
        streamModeContainer: streamModeContainer as HTMLElement | null,
        streamResults,
        streamSendButton: btnSendStream,
        toggleInputButton: btnToggleInput,
        toggleInputIcon,
        durationsContainer,
    });
    await streamController.syncInitialSettings();

    const btnScreenshot = document.getElementById('btnScreenshot') as HTMLButtonElement | null;
    const btnStop = document.getElementById('btnStopStream') as HTMLButtonElement | null;
    registerStopButton(btnStop);

    if (btnScreenshot) {
        btnScreenshot.addEventListener('click', async () => {
            const access = checkHolderAccess();
            if (access === 'holder') {
                await screenshotController.start();
            } else if (access === 'non-holder') {
                showHolderOnlyModal();
            } else {
                setStatus('Checking holder status...', 'sending');
                setTimeout(() => setStatus('Ready', 'ready'), 1500);
            }
        });
    }

    if (btnStop) {
        btnStop.addEventListener('click', async () => {
            if (await streamController.stopActiveStream()) {
                return;
            }
            if (screenshotController.cancelActive()) {
                return;
            }
            hideStopButton();
        });
    }

    const loadLogo = (logoElement: HTMLImageElement) => {
        if (!logoElement) return;
        try {
            logoElement.src = '../../brand/logo_white.png';
            logoElement.onerror = () => {
                logoElement.src = 'brand/logo_white.png';
                logoElement.onerror = () => {
                    logoElement.style.display = 'none';
                };
            };
        } catch (error) {
            console.warn('Could not load logo:', error);
            logoElement.style.display = 'none';
        }
    };

    const mainLogoElement = document.getElementById('main-logo') as HTMLImageElement;
    const logoContainer = document.querySelector('.logo-container') as HTMLElement;
    loadLogo(mainLogoElement);
    if (mainLogoElement && logoContainer) {
        startLogoAnimation(mainLogoElement, logoContainer);
    }
    const headerLogoElement = document.getElementById('header-logo') as HTMLImageElement;
    loadLogo(headerLogoElement);

    await initializeWelcomeModal();

    const settings = await settingsStore.load();
    const durations = Array.isArray(settings.durations) && settings.durations.length
        ? settings.durations
        : [5, 10, 15, 20, 30, 60];
    const durationHotkeys = settings.durationHotkeys;
    if (Array.isArray(durations) && durations.length) {
        try {
            (state as any).durationSec = Math.max(...durations);
        } catch {
        }
    }

    initControls({
        durations,
        onRecordToggle: async (shouldRecord) => {
            await streamController.handleRecordToggle(shouldRecord);
        },
        onDurationChange: (sec) => {
            streamController.handleAskWindow(sec);
        },
        onTextSend: (text) => {
            streamController.handleTextSend(text);
        },
    });

    try {
        const durationsEl = document.getElementById('durations') as HTMLDivElement | null;
        if (durationsEl && durationHotkeys) {
            const buttons = durationsEl.querySelectorAll('button');
            buttons.forEach((btn) => {
                const sec = Number((btn as HTMLButtonElement).dataset['sec'] || '0');
                const key = (durationHotkeys as any)[sec];
                if (!key) return;
                const old = btn.querySelector('.hk');
                if (old) old.remove();
                const label = document.createElement('span');
                label.className = 'hk text-xs text-gray-400 font-extralight';
                label.textContent = `Ctrl-${String(key).toUpperCase()}`;
                btn.appendChild(label);
            });
        }
    } catch {
    }

    window.api.hotkeys.onDuration((_e: unknown, payload: { sec: number }) => {
        try {
            streamController.handleAskWindow(payload.sec);
        } catch {
        }
    });

    window.api.hotkeys.onToggleInput(async () => {
        await streamController.handleHotkeyToggleRequest();
    });

    window.addEventListener('xexamai:settings-changed' as any, async (ev: any) => {
        try {
            const {key, value} = ev?.detail || {};
            const handled = streamController.handleSettingsChange(key, value);
            const finalized = handled instanceof Promise ? await handled : handled;
            if (finalized) {
                return;
            }
            switch (key) {
                case 'durations': {
                    const nextDurations: number[] = Array.isArray(value) ? value : [];
                    settingsStore.patch({ durations: nextDurations });
                    updateDurations(nextDurations, (sec) => {
                        streamController.handleAskWindow(sec);
                    });
                    try {
                        (state as any).durationSec = Math.max(...nextDurations);
                    } catch {
                    }
                    break;
                }
                case 'durationHotkeys': {
                    const map = (value ?? {}) as Record<number, string>;
                    settingsStore.patch({ durationHotkeys: map });
                    const durationsEl = document.getElementById('durations') as HTMLDivElement | null;
                    if (!durationsEl) break;
                    const buttons = durationsEl.querySelectorAll('button');
                    buttons.forEach((btn) => {
                        const old = btn.querySelector('.hk');
                        if (old) old.remove();
                        const sec = Number((btn as HTMLButtonElement).dataset['sec'] || '0');
                        const hotkey = map?.[sec];
                        if (!hotkey) return;
                        const label = document.createElement('span');
                        label.className = 'hk text-xs text-gray-400 font-extralight';
                        label.textContent = `Ctrl-${String(hotkey).toUpperCase()}`;
                        btn.appendChild(label);
                    });
                    break;
                }
                default:
                    break;
            }
        } catch (error) {
            console.error('settings change handler failed', error);
        }
    });

    const minimizeBtn = document.getElementById('minimizeBtn');
    const closeBtn = document.getElementById('closeBtn');

    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', () => {
            window.api.window.minimize();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            window.api.window.close();
        });
        closeBtn.blur();
        closeBtn.addEventListener('focus', () => {
            closeBtn.blur();
        });
    }
}
