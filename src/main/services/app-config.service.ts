import {app} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {logger} from './logger.service';
import {WhisperModel, TranscriptionMode, LocalDevice, DEFAULT_LLM_PROMPT} from '../shared/types';

export interface AppConfigData {
    openaiApiKey?: string;
    windowOpacity?: number;
    alwaysOnTop?: boolean;
    hideApp?: boolean;
    durations?: number[];
    durationHotkeys?: Record<number, string>;
    toggleInputHotkey?: string;
    audioInputDeviceId?: string;
    audioInputType?: 'microphone' | 'system';
    transcriptionModel?: string;
    transcriptionPrompt?: string;
    llmModel?: string;
    llmPrompt?: string;
    transcriptionMode?: TranscriptionMode;
    localWhisperModel?: WhisperModel;
    localDevice?: LocalDevice;
    // window size
    windowWidth?: number;
    windowHeight?: number;
    // timeouts (ms)
    apiSttTimeoutMs?: number; // OpenAI transcription API timeout
    apiLlmTimeoutMs?: number; // OpenAI chat completion timeout
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
                    hideApp: true,
                    durations: [5, 10, 15, 20, 30, 60],
                    durationHotkeys: {
                        5: '1',
                        10: '2',
                        15: '3',
                        20: '4',
                        30: '5',
                    },
                    transcriptionModel: 'gpt-4o-mini-transcribe',
                    transcriptionPrompt: 'This is a technical interview conducted in Russian. Please transcribe the speech in Russian, but preserve English programming and technical terms exactly as they are (e.g. Redis, Postgres, Celery, HTTP, API, and etc.).',
                    llmPrompt: DEFAULT_LLM_PROMPT,
                    transcriptionMode: 'api',
                    localWhisperModel: 'base',
                    localDevice: 'cpu',
                    windowWidth: 420,
                    windowHeight: 780,
                    apiSttTimeoutMs: 10000,
                    apiLlmTimeoutMs: 10000,
                };
                this.saveConfig();
            }
        } catch (error) {
            console.error('Error loading config:', error);
            this.configData = {
                windowOpacity: 100,
                alwaysOnTop: false,
                hideApp: true,
                durations: [5, 10, 15, 20, 30, 60],
                durationHotkeys: {
                    5: '1',
                    10: '2',
                    15: '3',
                    20: '4',
                    30: '5',
                },
                transcriptionModel: 'gpt-4o-mini-transcribe',
                transcriptionPrompt: 'This is a technical interview conducted in Russian. Please transcribe the speech in Russian, but preserve English programming and technical terms exactly as they are (e.g. Redis, Postgres, Celery, HTTP, API, and etc.).',
                llmPrompt: DEFAULT_LLM_PROMPT,
                transcriptionMode: 'api',
                localWhisperModel: 'base',
                localDevice: 'cpu',
                windowWidth: 420,
                windowHeight: 780,
                apiSttTimeoutMs: 10000,
                apiLlmTimeoutMs: 10000,
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
        // prune hotkeys for removed durations
        if (this.configData.durationHotkeys) {
            const next: Record<number, string> = {} as any;
            for (const d of durations) {
                const k = (this.configData.durationHotkeys as any)[d];
                if (k) next[d] = k;
            }
            this.configData.durationHotkeys = next;
        }
        this.saveConfig();
        logger.info('settings', 'Recording durations updated', { 
            oldDurations, 
            newDurations: durations 
        });
    }

    public setDurationHotkeys(map: Record<number, string>): void {
        const sanitized: Record<number, string> = {} as any;
        for (const [k, v] of Object.entries(map || {})) {
            const num = Number(k);
            if (!Number.isFinite(num)) continue;
            const key = String(v || '').trim();
            if (!key) continue;
            // allow single char 0-9,a-z
            if (/^[0-9a-zA-Z]$/.test(key)) {
                sanitized[num] = key.toLowerCase();
            }
        }
        const old = this.configData.durationHotkeys;
        this.configData.durationHotkeys = sanitized;
        this.saveConfig();
        logger.info('settings', 'Duration hotkeys updated', { old, next: sanitized });
    }

    public setToggleInputHotkey(key: string): void {
        const old = this.configData.toggleInputHotkey;
        const v = String(key || '').trim();
        if (/^[0-9a-zA-Z]$/.test(v)) {
            this.configData.toggleInputHotkey = v.toLowerCase();
            this.saveConfig();
            logger.info('settings', 'Toggle input hotkey updated', { old, next: this.configData.toggleInputHotkey });
        }
    }

    public getToggleInputHotkey(): string {
        const key = this.configData.toggleInputHotkey || 'g';
        return (/^[0-9a-zA-Z]$/.test(key) ? key.toLowerCase() : 'g');
    }

    public getDurationHotkeys(durations?: number[]): Record<number, string> {
        const existing = this.configData.durationHotkeys || {};
        const list = durations || this.getDurations();
        const defaultsOrder: Array<{ d: number; key: string }> = [
            { d: 5, key: '1' },
            { d: 10, key: '2' },
            { d: 15, key: '3' },
            { d: 20, key: '4' },
            { d: 30, key: '5' },
        ];
        const result: Record<number, string> = {} as any;
        for (const d of list) {
            const k = (existing as any)[d];
            if (k) {
                result[d] = String(k);
                continue;
            }
            const def = defaultsOrder.find(x => x.d === d);
            if (def) result[d] = def.key;
        }
        return result;
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

    public setWindowSize(width: number, height: number): void {
        const oldWidth = this.configData.windowWidth;
        const oldHeight = this.configData.windowHeight;
        const validWidth = Math.max(400, Math.floor(width || 0));
        const validHeight = Math.max(700, Math.floor(height || 0));
        this.configData.windowWidth = validWidth;
        this.configData.windowHeight = validHeight;
        this.saveConfig();
        logger.info('settings', 'Window size changed', {
            oldWidth,
            oldHeight,
            newWidth: validWidth,
            newHeight: validHeight,
        });
    }

    public getWindowWidth(): number {
        const w = this.configData.windowWidth || 420;
        return Math.max(400, w);
    }

    public getWindowHeight(): number {
        const h = this.configData.windowHeight || 780;
        return Math.max(700, h);
    }

    public setApiSttTimeoutMs(timeoutMs: number): void {
        const old = this.configData.apiSttTimeoutMs;
        const safe = Math.max(1000, Math.min(600000, Math.floor(timeoutMs || 0)));
        this.configData.apiSttTimeoutMs = safe;
        this.saveConfig();
        logger.info('settings', 'API STT timeout changed', { old, next: safe });
    }

    public getApiSttTimeoutMs(): number {
        return this.configData.apiSttTimeoutMs || 10000;
    }

    public setApiLlmTimeoutMs(timeoutMs: number): void {
        const old = this.configData.apiLlmTimeoutMs;
        const safe = Math.max(1000, Math.min(600000, Math.floor(timeoutMs || 0)));
        this.configData.apiLlmTimeoutMs = safe;
        this.saveConfig();
        logger.info('settings', 'API LLM timeout changed', { old, next: safe });
    }

    public getApiLlmTimeoutMs(): number {
        return this.configData.apiLlmTimeoutMs || 10000;
    }

    public setHideApp(hideApp: boolean): void {
        const oldValue = this.configData.hideApp;
        this.configData.hideApp = hideApp;
        this.saveConfig();
        logger.info('settings', 'Hide app changed', { 
            oldValue, 
            newValue: hideApp 
        });
    }

    public getHideApp(): boolean {
        return this.configData.hideApp !== undefined ? this.configData.hideApp : true;
    }
}

export const appConfigService = new AppConfigService();
