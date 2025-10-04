import {app} from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface AppConfigData {
    openaiApiKey?: string;
    windowOpacity?: number;
    durations?: number[];
    audioInputDeviceId?: string;
    audioInputType?: 'microphone' | 'system';
    transcriptionModel?: string;
}

export class AppConfigService {
    private configPath: string;
    private configData: AppConfigData = {};

    constructor() {
        const userDataPath = app.getPath('userData');
        const configDir = path.join(userDataPath, 'xexamai');

        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, {recursive: true});
        }

        this.configPath = path.join(configDir, 'config.json');
        this.loadConfig();
    }

    private loadConfig(): void {
        try {
            if (fs.existsSync(this.configPath)) {
                const data = fs.readFileSync(this.configPath, 'utf8');
                this.configData = JSON.parse(data);
            } else {
                this.configData = {
                    openaiApiKey: process.env.OPENAI_API_KEY,
                    windowOpacity: 100,
                    durations: [5, 10, 15, 20, 30, 60],
                    transcriptionModel: 'whisper-1'
                };
                this.saveConfig();
            }
        } catch (error) {
            console.error('Error loading config:', error);
            this.configData = {
                windowOpacity: 100,
                durations: [5, 10, 15, 20, 30, 60],
                transcriptionModel: 'whisper-1'
            };
        }
    }

    private saveConfig(): void {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.configData, null, 2));
        } catch (error) {
            console.error('Error saving config:', error);
        }
    }

    public getConfig(): AppConfigData {
        return {...this.configData};
    }

    public setOpenaiApiKey(key: string): void {
        this.configData.openaiApiKey = key;
        this.saveConfig();
    }

    public setWindowOpacity(opacity: number): void {
        this.configData.windowOpacity = Math.max(5, Math.min(100, opacity));
        this.saveConfig();
    }

    public setDurations(durations: number[]): void {
        this.configData.durations = durations;
        this.saveConfig();
    }

    public getConfigDirectory(): string {
        return path.dirname(this.configPath);
    }

    public getOpenaiApiKey(): string | undefined {
        return this.configData.openaiApiKey;
    }

    public getWindowOpacity(): number {
        return this.configData.windowOpacity || 100;
    }

    public getDurations(): number[] {
        return this.configData.durations || [5, 10, 15, 20, 30, 60];
    }

    public setAudioInputDevice(deviceId: string): void {
        this.configData.audioInputDeviceId = deviceId;
        this.saveConfig();
    }

    public getAudioInputDevice(): string | undefined {
        return this.configData.audioInputDeviceId;
    }

    public setAudioInputType(type: 'microphone' | 'system'): void {
        this.configData.audioInputType = type;
        this.saveConfig();
    }

    public getAudioInputType(): 'microphone' | 'system' {
        return this.configData.audioInputType || 'microphone';
    }

    public setTranscriptionModel(model: string): void {
        this.configData.transcriptionModel = model;
        this.saveConfig();
    }

    public getTranscriptionModel(): string {
        return this.configData.transcriptionModel || 'whisper-1';
    }
}

export const appConfigService = new AppConfigService();
