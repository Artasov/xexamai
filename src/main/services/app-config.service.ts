import {app} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {logger} from './logger.service';
import {WhisperModel, TranscriptionMode, LocalDevice, DEFAULT_LLM_PROMPT} from '../shared/types';

export interface AppConfigData {
    openaiApiKey?: string;
    windowOpacity?: number;
    alwaysOnTop?: boolean;
    durations?: number[];
    audioInputDeviceId?: string;
    audioInputType?: 'microphone' | 'system';
    transcriptionModel?: string;
    transcriptionPrompt?: string;
    llmModel?: string;
    llmPrompt?: string;
    transcriptionMode?: TranscriptionMode;
    localWhisperModel?: WhisperModel;
    localDevice?: LocalDevice;
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
                    alwaysOnTop: false,
                    durations: [5, 10, 15, 20, 30, 60],
                    transcriptionModel: 'gpt-4o-mini-transcribe',
                    transcriptionPrompt: 'This is a technical interview conducted in Russian. Please transcribe the speech in Russian, but preserve English programming and technical terms exactly as they are (e.g. Redis, Postgres, Celery, HTTP, API, and etc.).',
                    llmPrompt: DEFAULT_LLM_PROMPT,
                    transcriptionMode: 'api',
                    localWhisperModel: 'base',
                    localDevice: 'cpu'
                };
                this.saveConfig();
            }
        } catch (error) {
            console.error('Error loading config:', error);
            this.configData = {
                windowOpacity: 100,
                alwaysOnTop: false,
                durations: [5, 10, 15, 20, 30, 60],
                transcriptionModel: 'gpt-4o-mini-transcribe',
                transcriptionPrompt: 'This is a technical interview conducted in Russian. Please transcribe the speech in Russian, but preserve English programming and technical terms exactly as they are (e.g. Redis, Postgres, Celery, HTTP, API, and etc.).',
                llmPrompt: DEFAULT_LLM_PROMPT,
                transcriptionMode: 'api',
                localWhisperModel: 'base',
                localDevice: 'cpu'
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
        const oldKey = this.configData.openaiApiKey;
        this.configData.openaiApiKey = key;
        this.saveConfig();
        logger.info('settings', 'API key updated', { 
            hasOldKey: !!oldKey, 
            hasNewKey: !!key,
            keyLength: key?.length 
        });
    }

    public setWindowOpacity(opacity: number): void {
        const oldOpacity = this.configData.windowOpacity;
        this.configData.windowOpacity = Math.max(5, Math.min(100, opacity));
        this.saveConfig();
        logger.info('settings', 'Window opacity changed', { 
            oldOpacity, 
            newOpacity: this.configData.windowOpacity 
        });
    }

    public setDurations(durations: number[]): void {
        const oldDurations = this.configData.durations;
        this.configData.durations = durations;
        this.saveConfig();
        logger.info('settings', 'Recording durations updated', { 
            oldDurations, 
            newDurations: durations 
        });
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
        const oldDevice = this.configData.audioInputDeviceId;
        this.configData.audioInputDeviceId = deviceId;
        this.saveConfig();
        logger.info('settings', 'Audio input device changed', { 
            oldDevice, 
            newDevice: deviceId 
        });
    }

    public getAudioInputDevice(): string | undefined {
        return this.configData.audioInputDeviceId;
    }

    public setAudioInputType(type: 'microphone' | 'system'): void {
        const oldType = this.configData.audioInputType;
        this.configData.audioInputType = type;
        this.saveConfig();
        logger.info('settings', 'Audio input type changed', { 
            oldType, 
            newType: type 
        });
    }

    public getAudioInputType(): 'microphone' | 'system' {
        return this.configData.audioInputType || 'microphone';
    }

    public setTranscriptionModel(model: string): void {
        const oldModel = this.configData.transcriptionModel;
        this.configData.transcriptionModel = model;
        this.saveConfig();
        logger.info('settings', 'Transcription model changed', { 
            oldModel, 
            newModel: model 
        });
    }

    public getTranscriptionModel(): string {
        return this.configData.transcriptionModel || 'gpt-4o-mini-transcribe';
    }

    public setTranscriptionPrompt(prompt: string): void {
        const oldPrompt = this.configData.transcriptionPrompt;
        this.configData.transcriptionPrompt = prompt;
        this.saveConfig();
        logger.info('settings', 'Transcription prompt changed', { 
            oldPromptLength: oldPrompt?.length, 
            newPromptLength: prompt.length 
        });
    }

    public getTranscriptionPrompt(): string | undefined {
        return this.configData.transcriptionPrompt;
    }

    public setLlmModel(model: string): void {
        const oldModel = this.configData.llmModel;
        this.configData.llmModel = model;
        this.saveConfig();
        logger.info('settings', 'LLM model changed', { 
            oldModel, 
            newModel: model 
        });
    }

    public getLlmModel(): string {
        return this.configData.llmModel || 'gpt-4.1-nano';
    }

    public setTranscriptionMode(mode: TranscriptionMode): void {
        const oldMode = this.configData.transcriptionMode;
        this.configData.transcriptionMode = mode;
        this.saveConfig();
        logger.info('settings', 'Transcription mode changed', { 
            oldMode, 
            newMode: mode 
        });
    }

    public getTranscriptionMode(): TranscriptionMode {
        return this.configData.transcriptionMode || 'api';
    }

    public setLocalWhisperModel(model: WhisperModel): void {
        const oldModel = this.configData.localWhisperModel;
        this.configData.localWhisperModel = model;
        this.saveConfig();
        logger.info('settings', 'Local Whisper model changed', { 
            oldModel, 
            newModel: model 
        });
    }

    public getLocalWhisperModel(): WhisperModel {
        return this.configData.localWhisperModel || 'base';
    }

    public setAlwaysOnTop(alwaysOnTop: boolean): void {
        const oldValue = this.configData.alwaysOnTop;
        this.configData.alwaysOnTop = alwaysOnTop;
        this.saveConfig();
        logger.info('settings', 'Always on top changed', { 
            oldValue, 
            newValue: alwaysOnTop 
        });
    }

    public getAlwaysOnTop(): boolean {
        return this.configData.alwaysOnTop || false;
    }

    public setLocalDevice(device: LocalDevice): void {
        const oldDevice = this.configData.localDevice;
        this.configData.localDevice = device;
        this.saveConfig();
        logger.info('settings', 'Local device changed', { 
            oldDevice, 
            newDevice: device 
        });
    }

    public getLocalDevice(): LocalDevice {
        return this.configData.localDevice || 'cpu';
    }

    public setLlmPrompt(prompt: string): void {
        const oldPrompt = this.configData.llmPrompt;
        this.configData.llmPrompt = prompt;
        this.saveConfig();
        logger.info('settings', 'LLM prompt changed', { 
            oldPromptLength: oldPrompt?.length, 
            newPromptLength: prompt.length 
        });
    }

    public getLlmPrompt(): string | undefined {
        return this.configData.llmPrompt;
    }
}

export const appConfigService = new AppConfigService();
