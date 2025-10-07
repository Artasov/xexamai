import {BrowserWindow, ipcMain, shell} from 'electron';
import {AppSettings, DefaultSettings, IPCChannels, LocalDevice, LlmHost, TranscriptionMode, WhisperModel, DEFAULT_LLM_PROMPT} from '../shared/types';
import {appConfigService} from '../services/app-config.service';
import {logger} from '../services/logger.service';
import {hotkeysService} from '../services/hotkeys.service';
import {platform} from 'node:os';

export function registerSettingsIpc() {
    ipcMain.handle(IPCChannels.GetSettings, async (): Promise<AppSettings> => {
        logger.info('settings', 'Settings requested');
        const config = appConfigService.getConfig();
        return {
            durations: config.durations || DefaultSettings.durations,
            durationHotkeys: appConfigService.getDurationHotkeys(config.durations || DefaultSettings.durations),
            openaiApiKey: config.openaiApiKey,
            windowOpacity: config.windowOpacity || DefaultSettings.windowOpacity,
            alwaysOnTop: config.alwaysOnTop !== undefined ? config.alwaysOnTop : DefaultSettings.alwaysOnTop,
            hideApp: appConfigService.getHideApp(),
            windowWidth: config.windowWidth || 420,
            windowHeight: config.windowHeight || 780,
            audioInputDeviceId: config.audioInputDeviceId,
            audioInputType: config.audioInputType,
            transcriptionModel: config.transcriptionModel,
            transcriptionPrompt: config.transcriptionPrompt !== undefined ? config.transcriptionPrompt : 'This is a technical interview conducted in Russian. Please transcribe the speech in Russian, but preserve English programming and technical terms exactly as they are (e.g. Redis, Postgres, Celery, HTTP, API, and etc.).',
            llmModel: config.llmModel,
            llmPrompt: config.llmPrompt !== undefined ? config.llmPrompt : DEFAULT_LLM_PROMPT,
            transcriptionMode: config.transcriptionMode || DefaultSettings.transcriptionMode,
            llmHost: config.llmHost || DefaultSettings.llmHost,
            localWhisperModel: config.localWhisperModel || DefaultSettings.localWhisperModel,
            localDevice: config.localDevice || DefaultSettings.localDevice,
            apiSttTimeoutMs: appConfigService.getApiSttTimeoutMs(),
            apiLlmTimeoutMs: appConfigService.getApiLlmTimeoutMs(),
            geminiApiKey: config.geminiApiKey,
            streamMode: config.streamMode || DefaultSettings.streamMode,
            streamSendHotkey: config.streamSendHotkey || DefaultSettings.streamSendHotkey,
        };
    });

    ipcMain.handle(IPCChannels.SetOpenaiApiKey, async (_, key: string): Promise<void> => {
        appConfigService.setOpenaiApiKey(key);
    });

    ipcMain.handle(IPCChannels.SetWindowOpacity, async (_, opacity: number): Promise<void> => {
        appConfigService.setWindowOpacity(opacity);

        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (mainWindow) {
            mainWindow.setOpacity(opacity / 100);
        }
    });

    ipcMain.handle(IPCChannels.SetAlwaysOnTop, async (_, alwaysOnTop: boolean): Promise<void> => {
        appConfigService.setAlwaysOnTop(alwaysOnTop);

        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (mainWindow) {
            try {
                // Проверяем поддержку платформы
                const currentPlatform = platform();
                logger.info('settings', 'Setting always on top', { 
                    alwaysOnTop, 
                    platform: currentPlatform,
                    windowId: mainWindow.id 
                });

                mainWindow.setAlwaysOnTop(alwaysOnTop);
                
                // Дополнительная проверка для Windows
                if (currentPlatform === 'win32' && alwaysOnTop) {
                    // Принудительно показываем окно для Windows
                    if (mainWindow.isMinimized()) {
                        mainWindow.restore();
                    }
                    mainWindow.focus();
                    
                    // Дополнительная попытка для проблемных случаев
                    setTimeout(() => {
                        try {
                            mainWindow.setAlwaysOnTop(true, 'screen-saver');
                            logger.info('settings', 'Applied screen-saver level for always on top');
                        } catch (error) {
                            logger.warn('settings', 'Failed to apply screen-saver level', { error });
                        }
                    }, 100);
                }
                
                logger.info('settings', 'Always on top set successfully', { alwaysOnTop });
            } catch (error) {
                logger.error('settings', 'Failed to set always on top', { error, alwaysOnTop });
                throw error;
            }
        } else {
            logger.warn('settings', 'No main window found when setting always on top', { alwaysOnTop });
        }
    });

    ipcMain.handle(IPCChannels.SetHideApp, async (_, hideApp: boolean): Promise<void> => {
        appConfigService.setHideApp(hideApp);

        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (mainWindow) {
            try {
                logger.info('settings', 'Setting hide app', { 
                    hideApp, 
                    windowId: mainWindow.id 
                });

                mainWindow.setContentProtection(hideApp);
                mainWindow.setSkipTaskbar(hideApp);
            } catch (error) {
                logger.error('settings', 'Error setting hide app', { 
                    error: error instanceof Error ? error.message : String(error),
                    hideApp
                });
            }
        }
    });

    ipcMain.handle(IPCChannels.SetWindowSize, async (_,
        size: { width: number; height: number }
    ): Promise<void> => {
        const width = Math.max(400, Math.floor(size?.width || 0));
        const height = Math.max(700, Math.floor(size?.height || 0));
        appConfigService.setWindowSize(width, height);

        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (mainWindow) {
            try {
                mainWindow.setSize(width, height);
            } catch {}
        }
    });

    ipcMain.handle(IPCChannels.SetDurations, async (_, durations: number[]): Promise<void> => {
        appConfigService.setDurations(durations);
        // refresh hotkeys registrations
        hotkeysService.refresh();
    });

    ipcMain.handle(IPCChannels.SetDurationHotkeys, async (_, map: Record<number, string>): Promise<void> => {
        appConfigService.setDurationHotkeys(map);
        hotkeysService.refresh();
    });

    ipcMain.handle(IPCChannels.SetToggleInputHotkey, async (_, key: string): Promise<void> => {
        appConfigService.setToggleInputHotkey(key);
        hotkeysService.refresh();
    });

    ipcMain.handle(IPCChannels.SetAudioInputDevice, async (_, deviceId: string): Promise<void> => {
        appConfigService.setAudioInputDevice(deviceId);
    });

    ipcMain.handle(IPCChannels.SetAudioInputType, async (_, type: 'microphone' | 'system'): Promise<void> => {
        appConfigService.setAudioInputType(type);
    });

    ipcMain.handle(IPCChannels.SetTranscriptionModel, async (_, model: string): Promise<void> => {
        appConfigService.setTranscriptionModel(model);
    });

    ipcMain.handle(IPCChannels.SetTranscriptionPrompt, async (_, prompt: string): Promise<void> => {
        appConfigService.setTranscriptionPrompt(prompt);
    });

    ipcMain.handle(IPCChannels.SetLlmModel, async (_, model: string): Promise<void> => {
        appConfigService.setLlmModel(model);
    });

    ipcMain.handle(IPCChannels.SetLlmPrompt, async (_, prompt: string): Promise<void> => {
        appConfigService.setLlmPrompt(prompt);
    });

    ipcMain.handle(IPCChannels.GetAudioDevices, async (): Promise<{
        deviceId: string;
        label: string;
        kind: 'audioinput' | 'audiooutput'
    }[]> => {
        return [];
    });

    ipcMain.handle(IPCChannels.SetTranscriptionMode, async (_, mode: TranscriptionMode): Promise<void> => {
        appConfigService.setTranscriptionMode(mode);
    });

    ipcMain.handle(IPCChannels.SetLlmHost, async (_, host: LlmHost): Promise<void> => {
        appConfigService.setLlmHost(host);
    });

    ipcMain.handle(IPCChannels.SetLocalWhisperModel, async (_, model: WhisperModel): Promise<void> => {
        appConfigService.setLocalWhisperModel(model);
    });

    ipcMain.handle(IPCChannels.SetLocalDevice, async (_, device: LocalDevice): Promise<void> => {
        appConfigService.setLocalDevice(device);
    });

    ipcMain.handle(IPCChannels.SetApiSttTimeoutMs, async (_, timeoutMs: number): Promise<void> => {
        appConfigService.setApiSttTimeoutMs(timeoutMs);
    });

    ipcMain.handle(IPCChannels.SetApiLlmTimeoutMs, async (_, timeoutMs: number): Promise<void> => {
        appConfigService.setApiLlmTimeoutMs(timeoutMs);
    });

    ipcMain.handle(IPCChannels.OpenConfigFolder, async (): Promise<void> => {
        logger.info('settings', 'Opening config folder');
        const configDir = appConfigService.getConfigDirectory();
        shell.openPath(configDir);
    });

    // New Gemini settings handlers
    ipcMain.handle(IPCChannels.SetGeminiApiKey, async (_, key: string): Promise<void> => {
        appConfigService.setGeminiApiKey(key);
    });

    ipcMain.handle(IPCChannels.SetStreamMode, async (_, mode: 'base' | 'stream'): Promise<void> => {
        appConfigService.setStreamMode(mode);
    });

    ipcMain.handle(IPCChannels.SetStreamSendHotkey, async (_, key: string): Promise<void> => {
        appConfigService.setStreamSendHotkey(key);
    });
}

