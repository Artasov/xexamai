import {BrowserWindow, ipcMain, shell} from 'electron';
import {AppSettings, DefaultSettings, IPCChannels} from '../shared/types';
import {appConfigService} from '../services/app-config.service';

export function registerSettingsIpc() {
    ipcMain.handle(IPCChannels.GetSettings, async (): Promise<AppSettings> => {
        const config = appConfigService.getConfig();
        return {
            durations: config.durations || DefaultSettings.durations,
            openaiApiKey: config.openaiApiKey,
            windowOpacity: config.windowOpacity || DefaultSettings.windowOpacity,
            audioInputDeviceId: config.audioInputDeviceId,
            audioInputType: config.audioInputType,
            transcriptionModel: config.transcriptionModel,
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

    ipcMain.handle(IPCChannels.SetDurations, async (_, durations: number[]): Promise<void> => {
        appConfigService.setDurations(durations);
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

    ipcMain.handle(IPCChannels.GetAudioDevices, async (): Promise<{
        deviceId: string;
        label: string;
        kind: 'audioinput' | 'audiooutput'
    }[]> => {
        return [];
    });

    ipcMain.handle(IPCChannels.OpenConfigFolder, async (): Promise<void> => {
        const configDir = appConfigService.getConfigDirectory();
        shell.openPath(configDir);
    });
}

