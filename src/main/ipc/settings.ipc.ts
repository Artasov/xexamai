import {BrowserWindow, ipcMain, shell} from 'electron';
import {AppSettings, DefaultSettings, IPCChannels, LocalDevice, TranscriptionMode, WhisperModel, DEFAULT_LLM_PROMPT} from '../shared/types';
import {appConfigService} from '../services/app-config.service';
import {logger} from '../services/logger.service';
import {hotkeysService} from '../services/hotkeys.service';

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
            windowWidth: config.windowWidth || 420,
            windowHeight: config.windowHeight || 780,
            audioInputDeviceId: config.audioInputDeviceId,
            audioInputType: config.audioInputType,
            transcriptionModel: config.transcriptionModel,
            transcriptionPrompt: config.transcriptionPrompt !== undefined ? config.transcriptionPrompt : 'This is a technical interview conducted in Russian. Please transcribe the speech in Russian, but preserve English programming and technical terms exactly as they are (e.g. Redis, Postgres, Celery, HTTP, API, and etc.).',
            llmModel: config.llmModel,
            llmPrompt: config.llmPrompt !== undefined ? config.llmPrompt : DEFAULT_LLM_PROMPT,
            transcriptionMode: config.transcriptionMode || DefaultSettings.transcriptionMode,
            localWhisperModel: config.localWhisperModel || DefaultSettings.localWhisperModel,
            localDevice: config.localDevice || DefaultSettings.localDevice,
            apiSttTimeoutMs: appConfigService.getApiSttTimeoutMs(),
            apiLlmTimeoutMs: appConfigService.getApiLlmTimeoutMs(),
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
            mainWindow.setAlwaysOnTop(alwaysOnTop);
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
}

