import type {AppSettings} from '../types.js';
import {logger} from '../utils/logger.js';
import {registerHolderSettingsSection} from './holderAccess.js';
import {CustomSelect, CustomSelectOption} from './components/CustomSelect.js';
import {settingsStore} from '../state/settingsStore.js';

export interface SettingsPanelOptions {
    onSettingsChange?: (settings: AppSettings) => void;
    onDurationsChange?: (durations: number[]) => void;
    onHotkeysChange?: (map: Record<number, string>) => void;
    panelType?: 'general' | 'ai' | 'audio' | 'hotkeys';
}

export class SettingsPanel {
    private container: HTMLElement;
    private options: SettingsPanelOptions;
    private settings: AppSettings = {
        durations: [5, 10, 15, 20, 30, 60],
        windowOpacity: 100,
        screenProcessingTimeoutMs: 50000,
    };
    private panelType: 'general' | 'ai' | 'audio' | 'hotkeys' = 'general';
    private initialWindowScale: number | undefined;

    // Custom select instances
    private csTranscriptionMode?: CustomSelect;
    private csTranscriptionModel?: CustomSelect;
    private csLocalWhisperModel?: CustomSelect;
    private csLocalDevice?: CustomSelect;
    private csLlmHost?: CustomSelect;
    private csLlmModel?: CustomSelect;
    private csLocalLlmModel?: CustomSelect;
    private csAudioInputType?: CustomSelect;
    private csAudioInputDevice?: CustomSelect;
    private csStreamMode?: CustomSelect;
    private csScreenProcessingModel?: CustomSelect;

    constructor(container: HTMLElement, options: SettingsPanelOptions = {}) {
        this.container = container;
        this.options = options;
        this.panelType = options.panelType || 'general';
        this.init().then();
    }

    private updateSettings(partial: Partial<AppSettings>) {
        this.settings = {...this.settings, ...partial};
        settingsStore.patch(partial);
    }

    private hasOpenAiKey(): boolean {
        const snapshot = settingsStore.get();
        const stored = snapshot.openaiApiKey ?? this.settings.openaiApiKey;
        if (typeof stored === 'string' && stored.trim().length > 0) return true;
        const input = this.container.querySelector('#openaiApiKey') as HTMLInputElement | null;
        return !!input && input.value.trim().length > 0;
    }

    private hasGoogleKey(): boolean {
        const snapshot = settingsStore.get();
        const stored = snapshot.googleApiKey ?? this.settings.googleApiKey;
        if (typeof stored === 'string' && stored.trim().length > 0) return true;
        const input = this.container.querySelector('#googleApiKey') as HTMLInputElement | null;
        return !!input && input.value.trim().length > 0;
    }

    private async init() {
        try {
            try {
                this.settings = settingsStore.get();
            } catch {
                this.settings = await settingsStore.load();
            }
            if (!(this.settings as any).screenProcessingTimeoutMs) {
                (this.settings as any).screenProcessingTimeoutMs = 50000;
            }
        } catch (error) {
            console.error('Error loading settings:', error);
        }

        this.initialWindowScale = this.settings.windowScale || 1.0;

        this.render();
        this.initCustomSelects();
        this.attachEventListeners();
        await this.loadAudioDevices();
        this.updateAudioTypeVisibility();
        this.updateTranscriptionModeVisibility();
        this.updateLlmHostVisibility();
    }

    private render() {
        this.container.innerHTML = `
            <div class="settings-panel">
                ${this.renderGeneralSections()}
                ${this.renderAiSections()}
                ${this.renderAudioSections()}
                ${this.renderHotkeysSections()}
            </div>
        `;

        this.renderDurations();
        if (this.panelType === 'general') {
            registerHolderSettingsSection(this.container);
        }
    }

    private renderGeneralSections(): string {
        if (this.panelType !== 'general') return '';
        
        return `
                <div class="fr gap-2 flex-wrap">
                
                    <div class="settings-section card flex-grow">
                        <h3 class="settings-title">API Keys</h3>
                        <div class="fr flex-wrap gap-2">
                            <div class="input-group fc flex-grow">
                                <span class="text-xs text-gray-400">OpenAI</span>
                                <input 
                                    type="password" 
                                    id="openaiApiKey" 
                                    class="input-field" 
                                    placeholder="Enter your OpenAI API key"
                                    value="${this.settings.openaiApiKey || ''}"
                                />
                                <button id="saveApiKey" class="btn btn-sm">Save</button>
                            </div>
                            <div class="input-group fc flex-grow">
                                <span class="text-xs text-gray-400">Google</span>
                                <input 
                                    type="password" 
                                    id="googleApiKey" 
                                    class="input-field" 
                                    placeholder="Enter your Google API key"
                                    value="${this.settings.googleApiKey || ''}"
                                />
                                <button id="saveGoogleApiKey" class="btn btn-sm">Save</button>
                            </div>
                        </div>
                    </div>

                    <div class="settings-section card flex-grow" id="holderAuthCard">
                        <h3 class="settings-title">Holder access</h3>
                        <p class="text-xs text-gray-400 mb-2">
                            Verify ownership of token D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG to unlock holder-only features.
                        </p>
                        <div class="frsc gap-2 flex-wrap">
                            <button id="holderAuthBtn" class="btn btn-primary btn-sm">I'm holder</button>
                            <span id="holderStatusBadge" class="px-2 py-1 text-xs rounded border border-gray-700 text-gray-300 bg-gray-800/60">
                                Status: unknown
                            </span>
                        </div>
                        <div id="holderStatusDetails" class="text-xs text-gray-500 mt-2"></div>
                    </div>
    
                    <div class="settings-section card flex-grow">
                        <h3 class="settings-title">Window behavior</h3>
                        <div class="fc gap-1">
                            <div class="checkbox-control">
                                <label class="checkbox-label">
                                    <input 
                                        type="checkbox" 
                                        id="alwaysOnTop" 
                                        class="checkbox-input"
                                        ${this.settings.alwaysOnTop ? 'checked' : ''}
                                    />
                                    <span class="checkbox-text">Always on top</span>
                                </label>
                            </div>
                            <div class="checkbox-control">
                                <label class="checkbox-label">
                                    <input 
                                        type="checkbox" 
                                        id="hideApp" 
                                        class="checkbox-input"
                                        ${this.settings.hideApp ? 'checked' : ''}
                                    />
                                    <span class="checkbox-text">Hide app from screen recording</span>
                                </label>
                            </div>
        
                            <div class="frsc gap-2">
                                <span class="checkbox-text">Window opacity</span>
                                <div class="opacity-control">
                                    <input 
                                        type="range" 
                                        id="windowOpacity" 
                                        class="opacity-slider" 
                                        min="5" 
                                        max="100" 
                                        value="${this.settings.windowOpacity || 100}"
                                    />
                                    <span id="opacityValue" class="opacity-value">${this.settings.windowOpacity || 100}%</span>
                                </div>
                            </div>
                            
                            <div class="frsc gap-2">
                                <span class="checkbox-text">Window scale</span>
                                <div class="opacity-control">
                                    <input 
                                        type="range" 
                                        id="windowScale" 
                                        class="opacity-slider" 
                                        min="0.5" 
                                        max="3.0" 
                                        step="0.1"
                                        value="${this.settings.windowScale || 1.0}"
                                    />
                                    <span id="scaleValue" class="opacity-value">${this.settings.windowScale || 1.0}x</span>
                                </div>
                            </div>
                            <div id="scaleRestartNote" class="text-xs text-gray-400 mt-1" style="display:none;">
                                ⚠️ Changing the scale requires restarting the application
                            </div>
                        </div>
                    </div>

                    <div class="settings-section card fc gap-2 flex-grow">
                        <h3 class="settings-title">Window size on startup</h3>
                        <div class="fr flex-wrap gap-2">
                            <div class="fc gap-1 flex-grow">
                                <label for="windowWidth" class="text-xs text-gray-400">Width (min 400)</label>
                                <input 
                                    type="number" 
                                    id="windowWidth" 
                                    class="input-field" 
                                    min="400" 
                                    value="${Math.max(400, this.settings.windowWidth || 420)}"
                                />
                            </div>
                            <div class="fc gap-1 flex-grow">
                                <label for="windowHeight" class="text-xs text-gray-400">Height (min 700)</label>
                                <input 
                                    type="number" 
                                    id="windowHeight" 
                                    class="input-field" 
                                    min="700" 
                                    value="${Math.max(700, this.settings.windowHeight || 780)}"
                                />
                            </div>
                        </div>
                        <button id="saveWindowSize" class="btn btn-sm">Save</button>
                    </div>

                    <div class="settings-section card">
                        <h3 class="settings-title">Config Folder</h3>
                        <button id="openConfigFolder" class="btn frsc gap-2">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 7v10a2 2 0 002 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 0-2-2z"/>
                                <path d="M8 21v-4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4"/>
                            </svg>
                            Open Config Folder
                        </button>
                    </div>
                    
                </div>
        `;
    }

    private renderAiSections(): string {
        if (this.panelType !== 'ai') return '';
        
        return `
                <div class="settings-section card fc">
                    <h3 class="settings-title">Mode</h3>
                    <div class="fr gap-1 flex-wrap">
                        <div class="fc gap-1 flex-grow">
                            <h3 class="text-xs text-gray-400">Transcription</h3>
                            <div id="transcriptionMode" class="min-w-[100px]"></div>
                        </div>
                        <div class="fc gap-1 flex-grow">
                            <h3 class="text-xs text-gray-400">LLM</h3>
                            <div id="llmHost" class="min-w-[100px]"></div>
                        </div>
                        <div class="fc gap-1 flex-grow">
                            <h3 class="text-xs text-gray-400">Transcription type</h3>
                            <div id="streamMode" class="min-w-[100px]"></div>
                        </div>
                    </div>
                </div>
                
                <div class="settings-section card fc">
                    <h3 class="settings-title">Model</h3>
                    
                    <div class="fr flex-wrap">
                        <div class="fc gap-1">
                            <div class="fc gap-1 mr-2 mb-1" id="apiTranscriptionSection">
                                <div class="fc">
                                    <h3 class="text-xs text-gray-400">Transcription</h3>
                                    <div id="transcriptionModel"></div>
                                </div>
                            </div>
                            <div class="fc gap-1 mr-2 mb-1" id="localTranscriptionSection" style="display: none;">
                                <h3 class="text-xs text-gray-400">Transcription</h3>
                                <div id="localWhisperModel"></div>
                            </div>
                            <div class="fc gap-1 mr-2 mb-1" id="localDeviceSection" style="display: none;">
                                <h3 class="text-xs text-gray-400">Local transcription device</h3>
                                <div id="localDevice"></div>
                            </div>
                        </div>

                        <div class="fr gap-1 mr-2 mb-2">
                            <div class="fc gap-1" id="apiLlmSection">
                                <div class="fc gap-1">
                                    <h3 class="text-xs text-gray-400">LLM</h3>
                                    <div id="llmModel"></div>
                                </div>
                            </div>
                            <div class="fc gap-1" id="localLlmSection" style="display: none;">
                                <h3 class="text-xs text-gray-400">LLM</h3>
                                <div id="localLlmModel"></div>
                            </div>
                        </div>

                        <div class="fc gap-1 flex-grow min-w-[200px]">
                            <h3 class="text-xs text-gray-400">Screen processing</h3>
                            <div id="screenProcessingModel"></div>
                        </div>
                    </div>
                    
                </div>
                
                <div class="settings-section card fc">
                    <h3 class="settings-title">Prompt</h3>
                    
                    <div class="fr gap-2 flex-wrap">
                        <div class="fc gap-1 flex-grow">
                            <h3 class="text-xs text-gray-400">Transcription</h3>
                            <div class="fc gap-2">
                                <textarea 
                                    id="transcriptionPrompt" 
                                    class="input-field prompt-textarea" 
                                    placeholder="Enter transcription prompt (leave empty to disable prompt)..."
                                    rows="4"
                                >${this.settings.transcriptionPrompt || ''}</textarea>
                                <button id="saveTranscriptionPrompt" class="btn btn-sm">Save Prompt</button>
                            </div>
                        </div>
        
                        <div class="fc gap-1 flex-grow">
                            <h3 class="text-xs text-gray-400">LLM</h3>
                            <div class="fc gap-2">
                                <textarea 
                                    id="llmPrompt" 
                                    class="input-field prompt-textarea" 
                                    placeholder="Enter LLM system prompt (leave empty to use default)..."
                                    rows="4"
                                >${this.settings.llmPrompt || ''}</textarea>
                                <button id="saveLlmPrompt" class="btn btn-sm">Save Prompt</button>
                            </div>
                        </div>

                        <div class="fc gap-1 flex-grow">
                            <h3 class="text-xs text-gray-400">Screen processing</h3>
                            <div class="fc gap-2">
                                <textarea 
                                    id="screenProcessingPrompt" 
                                    class="input-field prompt-textarea" 
                                    placeholder="Enter prompt for screenshot analysis..."
                                    rows="4"
                                >${this.settings.screenProcessingPrompt || ''}</textarea>
                                <button id="saveScreenProcessingPrompt" class="btn btn-sm">Save Prompt</button>
                            </div>
                        </div>
                    </div>
                    
                </div>


                <div class="settings-section card">
                    <h3 class="settings-title">API timeouts <span class="text-xs text-gray-400">(ms)</span></h3>
                    <div class="frb gap-2 flex-wrap">
                        <div class="fc gap-1" style="width:31%">
                            <label class="text-xs text-gray-400">Transcription</label>
                            <input id="apiSttTimeoutMs" type="number" class="input-field" min="1000" max="600000" step="500" value="${(this.settings as any).apiSttTimeoutMs || 10000}" />
                            <button id="saveApiSttTimeout" class="btn btn-sm">Save</button>
                        </div>
                        <div class="fc gap-1" style="width:31%">
                            <label class="text-xs text-gray-400">LLM</label>
                            <input id="apiLlmTimeoutMs" type="number" class="input-field" min="1000" max="600000" step="500" value="${(this.settings as any).apiLlmTimeoutMs || 10000}" />
                            <button id="saveApiLlmTimeout" class="btn btn-sm">Save</button>
                        </div>
                        <div class="fc gap-1" style="width:31%">
                            <label class="text-xs text-gray-400">Screen processing</label>
                            <input id="screenProcessingTimeoutMs" type="number" class="input-field" min="1000" max="600000" step="500" value="${(this.settings as any).screenProcessingTimeoutMs || 50000}" />
                            <button id="saveScreenProcessingTimeout" class="btn btn-sm">Save</button>
                        </div>
                    </div>
                </div>
        `;
    }

    private renderAudioSections(): string {
        if (this.panelType !== 'audio') return '';
        
        return `
                <div class="fr gap-2 flex-wrap">
                    <div class="settings-section card min-w-[200px]">
                        <h3 class="settings-title">Audio input</h3>
                        <div id="audioInputType"></div>
                    </div>
    
                    <div class="settings-section card fc flex-grow" id="microphoneSection">
                        <h3 class="settings-title">Microphone device</h3>
                        <div class="fc gap-1">
                            <div id="audioInputDevice"></div>
                            <button id="refreshDevices" class="btn btn-sm">Refresh</button>
                        </div>
                    </div>
                </div>
        `;
    }

    private renderHotkeysSections(): string {
        if (this.panelType !== 'hotkeys') return '';
        
        return `
                <div class="settings-section card">
                    <h3 class="settings-title">Recording durations</h3>
                    <div class="durations-control">
                        <div id="durationsList" class="durations-list"></div>
                        <div class="duration-input-group">
                            <input 
                                type="number" 
                                id="newDuration" 
                                class="input-field" 
                                placeholder="Duration in seconds"
                                min="1"
                                max="300"
                            />
                            <button id="addDuration" class="btn btn-sm">Add</button>
                        </div>
                    </div>
                </div>

                <div class="settings-section card">
                    <h3 class="settings-title">Hotkey: toggle audio input</h3>
                    <div class="fc gap-2">
                        <div class="frsc gap-2">
                            <label class="input-label" for="toggleInputHotkey">Ctrl-</label>
                            <input id="toggleInputHotkey" class="input-field w-24" maxlength="1" placeholder="G" value="${(this.settings as any).toggleInputHotkey || 'g'}" />
                            <button id="saveToggleInputHotkey" class="btn btn-sm">Save</button>
                        </div>
                        <div class="text-xs text-gray-400">Single letter or digit, used with Ctrl (e.g., Ctrl-G)</div>
                    </div>
                </div>

                <div class="settings-section card">
                    <h3 class="settings-title">Hotkey: send from stream textarea</h3>
                    <div class="fc gap-2">
                        <div class="frsc gap-2">
                            <label class="input-label" for="streamSendHotkey">Ctrl-</label>
                            <input id="streamSendHotkey" class="input-field w-24" maxlength="1" placeholder="~" value="${(this.settings as any).streamSendHotkey || '~'}" />
                            <button id="saveStreamSendHotkey" class="btn btn-sm">Save</button>
                        </div>
                        <div class="text-xs text-gray-400">Single character for sending text from stream results (e.g., Ctrl-~)</div>
                    </div>
                </div>
        `;
    }


    private updateAudioTypeVisibility() {
        const microphoneSection = this.container.querySelector('#microphoneSection') as HTMLElement;
        if (microphoneSection) {
            const typeVal = this.csAudioInputType?.getValue() || this.settings.audioInputType || 'microphone';
            const isMicrophone = typeVal === 'microphone';
            microphoneSection.style.display = isMicrophone ? 'flex' : 'none';
        }
    }

    private updateTranscriptionModeVisibility() {
        const apiSection = this.container.querySelector('#apiTranscriptionSection') as HTMLElement;
        const localSection = this.container.querySelector('#localTranscriptionSection') as HTMLElement;
        const localDeviceSection = this.container.querySelector('#localDeviceSection') as HTMLElement;
        if (apiSection && localSection && localDeviceSection) {
            const streamMode = this.csStreamMode?.getValue() || this.settings.streamMode || 'base';
            let modeVal = this.csTranscriptionMode?.getValue() || this.settings.transcriptionMode || 'api';
            if (streamMode === 'stream' && modeVal !== 'api') {
                this.csTranscriptionMode?.setValue('api');
                modeVal = 'api';
                this.updateSettings({ transcriptionMode: 'api' });
                this.settings.transcriptionMode = 'api';
            }
            const isLocal = modeVal === 'local';
            const hideApi = isLocal || streamMode === 'stream';
            apiSection.style.display = hideApi ? 'none' : 'flex';
            localSection.style.display = isLocal ? 'flex' : 'none';
            localDeviceSection.style.display = isLocal ? 'flex' : 'none';
        }
    }

    private updateLlmHostVisibility() {
        const apiSection = this.container.querySelector('#apiLlmSection') as HTMLElement;
        const localSection = this.container.querySelector('#localLlmSection') as HTMLElement;
        if (apiSection && localSection) {
            const hostVal = this.csLlmHost?.getValue() || this.settings.llmHost || 'api';
            const isLocal = hostVal === 'local';
            apiSection.style.display = isLocal ? 'none' : 'flex';
            localSection.style.display = isLocal ? 'flex' : 'none';
        }
    }

    private async loadAudioDevices() {
        try {
            const devices = await window.api.settings.getAudioDevices();
            const opts: CustomSelectOption[] = [
                { value: '', label: 'Default (System Default)' }
            ];
            devices.forEach((device: { deviceId: string; label: string; kind: 'audioinput' | 'audiooutput' }) => {
                const maxLength = 50;
                const displayLabel = device.label.length > maxLength
                    ? device.label.substring(0, maxLength) + '...'
                    : device.label;
                opts.push({ value: device.deviceId, label: displayLabel, title: device.label });
            });
            if (this.csAudioInputDevice) {
                this.csAudioInputDevice.setOptions(opts);
                this.csAudioInputDevice.setValue(this.settings.audioInputDeviceId || '');
            }
        } catch (error) {
            console.error('Error loading audio devices:', error);
            if (this.csAudioInputDevice) {
                this.csAudioInputDevice.setOptions([{ value: '', label: 'Error loading devices' }]);
                this.csAudioInputDevice.setValue('');
            }
        }
    }

    private renderDurations() {
        const durationsList = this.container.querySelector('#durationsList');
        if (!durationsList) return;

        const hotkeys = (this.settings as any).durationHotkeys || {};
        durationsList.innerHTML = this.settings.durations?.map((duration: number) => `
            <div class="duration-item">
                <span class="duration-value">${duration}s</span>
                <input 
                    class="input-field hotkey-input !py-0" 
                    data-duration="${duration}"
                    maxlength="1"
                    placeholder="Key"
                    value="${(hotkeys as any)[duration] ? String((hotkeys as any)[duration]).toUpperCase() : ''}"
                    style="width:60px;text-transform:uppercase;"
                    title="Specify a character for Ctrl-<key>"
                />
                <button class="btn btn-sm save-hotkey" data-duration="${duration}">Save</button>
                <button class="btn btn-sm btn-danger remove-duration !px-1 !py-1" data-duration="${duration}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </button>
            </div>
        `).join('') || '';
    }

    private initCustomSelects() {
        // Transcription Mode
        const tmEl = this.container.querySelector('#transcriptionMode') as HTMLElement | null;
        if (tmEl) {
            const opts: CustomSelectOption[] = [
                { value: 'api', label: 'API' },
                { value: 'local', label: 'Local' },
            ];
            this.csTranscriptionMode = new CustomSelect(
                tmEl,
                opts,
                this.settings.transcriptionMode || 'api',
                async (val) => {
                    const mode = (val as 'api' | 'local');
                    logger.info('settings', 'Transcription mode changed', { mode });
                    const previous = this.settings.transcriptionMode || 'api';
                    try {
                        if (mode === 'api' && !this.hasOpenAiKey()) {
                            this.showNotification('Add an OpenAI API key before using API transcription mode', 'error');
                            this.csTranscriptionMode?.setValue(previous);
                            return;
                        }
                        if (mode === 'local' && (this.csStreamMode?.getValue() || this.settings.streamMode) === 'stream') {
                            this.showNotification('Disable Google Stream mode before switching to Local transcription', 'error');
                            this.csTranscriptionMode?.setValue('api');
                            return;
                        }
                        await window.api.settings.setTranscriptionMode(mode);
                        this.updateSettings({ transcriptionMode: mode });
                        this.settings.transcriptionMode = mode;
                        this.updateTranscriptionModeVisibility();
                        this.showNotification(`Transcription mode changed to ${mode === 'api' ? 'API' : 'Local'}`);
                    } catch (error) {
                        this.showNotification('Error saving transcription mode', 'error');
                        this.csTranscriptionMode?.setValue(previous);
                    }
                }
            );
        }

        // API Transcription Model
        const tmodelEl = this.container.querySelector('#transcriptionModel') as HTMLElement | null;
        if (tmodelEl) {
            const opts: CustomSelectOption[] = [
                { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe (Default)' },
                { value: 'whisper-1', label: 'Whisper-1 (Balanced)' },
                { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe (High Quality)' },
            ];
            this.csTranscriptionModel = new CustomSelect(
                tmodelEl,
                opts,
                this.settings.transcriptionModel || 'gpt-4o-mini-transcribe',
                async (val) => {
                    const model = val;
                    logger.info('settings', 'Transcription model changed', { model });
                    const previous = this.settings.transcriptionModel || 'gpt-4o-mini-transcribe';
                    try {
                        if (!this.hasOpenAiKey()) {
                            this.showNotification('Add an OpenAI API key before choosing transcription models', 'error');
                            this.csTranscriptionModel?.setValue(previous);
                            return;
                        }
                        await window.api.settings.setTranscriptionModel(model);
                        this.updateSettings({ transcriptionModel: model });
                        this.settings.transcriptionModel = model;
                        this.showNotification(`Transcription model changed to ${model}`);
                    } catch (error) {
                        this.showNotification('Error saving transcription model', 'error');
                        this.csTranscriptionModel?.setValue(previous);
                    }
                }
            );
        }

        // Local Whisper Model
        const lwmEl = this.container.querySelector('#localWhisperModel') as HTMLElement | null;
        if (lwmEl) {
            const opts: CustomSelectOption[] = [
                { value: 'tiny', label: 'Tiny (~39 MB) - Fast, less accurate' },
                { value: 'base', label: 'Base (~74 MB) - Balanced speed and accuracy' },
                { value: 'small', label: 'Small (~244 MB) - Good accuracy' },
                { value: 'medium', label: 'Medium (~769 MB) - High accuracy' },
                { value: 'large', label: 'Large (~1550 MB) - Very high accuracy' },
                { value: 'large-v2', label: 'Large V2 (~1550 MB) - Improved version of Large' },
                { value: 'large-v3', label: 'Large V3 (~1550 MB) - Latest version of Large' },
            ];
            this.csLocalWhisperModel = new CustomSelect(
                lwmEl,
                opts,
                this.settings.localWhisperModel || 'base',
                async (val) => {
                    const model = (val as 'tiny' | 'base' | 'small' | 'medium' | 'large' | 'large-v2' | 'large-v3');
                    logger.info('settings', 'Local Whisper model changed', { model });
                    try {
                        await window.api.settings.setLocalWhisperModel(model);
                        this.updateSettings({ localWhisperModel: model });
                        this.settings.localWhisperModel = model;
                        this.showNotification(`Local Whisper model changed to ${model}`);
                    } catch (error) {
                        this.showNotification('Error saving local Whisper model', 'error');
                    }
                }
            );
        }

        // Local Device
        const ldevEl = this.container.querySelector('#localDevice') as HTMLElement | null;
        if (ldevEl) {
            const opts: CustomSelectOption[] = [
                { value: 'cpu', label: 'CPU - Stable, slower' },
                { value: 'gpu', label: 'GPU - Faster, requires CUDA/OpenCL' },
            ];
            this.csLocalDevice = new CustomSelect(
                ldevEl,
                opts,
                this.settings.localDevice || 'cpu',
                async (val) => {
                    const device = (val as 'cpu' | 'gpu');
                    logger.info('settings', 'Local device changed', { device });
                    try {
                        await window.api.settings.setLocalDevice(device);
                        this.updateSettings({ localDevice: device });
                        this.settings.localDevice = device;
                        this.showNotification(`Local device changed to ${device.toUpperCase()}`);
                    } catch (error) {
                        this.showNotification('Error saving local device', 'error');
                    }
                }
            );
        }

        // LLM Host
        const llmHostEl = this.container.querySelector('#llmHost') as HTMLElement | null;
        if (llmHostEl) {
            const opts: CustomSelectOption[] = [
                { value: 'api', label: 'API' },
                { value: 'local', label: 'Local' },
            ];
            this.csLlmHost = new CustomSelect(
                llmHostEl,
                opts,
                this.settings.llmHost || 'api',
                async (val) => {
                    const host = (val as 'api' | 'local');
                    logger.info('settings', 'LLM host changed', { host });
                    const previous = this.settings.llmHost || 'api';
                    try {
                        if (host === 'api' && !this.hasOpenAiKey() && !this.hasGoogleKey()) {
                            this.showNotification('Add an OpenAI or Google API key before using API LLM host', 'error');
                            this.csLlmHost?.setValue(previous);
                            return;
                        }
                        await window.api.settings.setLlmHost(host);
                        this.updateSettings({ llmHost: host });
                        this.settings.llmHost = host;
                        this.updateLlmHostVisibility();
                        
                        // Автоматически переключаем на подходящую модель по умолчанию
                        let defaultModel = 'gpt-oss:20b';
                        if (host === 'api') {
                            if (this.hasOpenAiKey()) {
                                defaultModel = 'gpt-4.1-nano';
                            } else if (this.hasGoogleKey()) {
                                defaultModel = 'gemini-1.5-flash';
                            }
                        }
                        await window.api.settings.setLlmModel(defaultModel);
                        this.updateSettings({ llmModel: defaultModel });
                        this.settings.llmModel = defaultModel;
                        
                        // Обновляем значения в селектах
                        if (host === 'api' && this.csLlmModel) {
                            this.csLlmModel.setValue(defaultModel);
                        } else if (host === 'local' && this.csLocalLlmModel) {
                            this.csLocalLlmModel.setValue(defaultModel);
                        }
                        
                        this.showNotification(`LLM host changed to ${host === 'api' ? 'API' : 'Local'}. Model set to ${defaultModel}`);
                    } catch (error) {
                        this.showNotification('Error saving LLM host', 'error');
                        this.csLlmHost?.setValue(previous);
                    }
                }
            );
        }

        const screenModelEl = this.container.querySelector('#screenProcessingModel') as HTMLElement | null;
        if (screenModelEl) {
            const opts: CustomSelectOption[] = [
                { value: 'openai', label: 'OpenAI (GPT-4o Mini Vision)' },
                { value: 'google', label: 'Google Gemini (1.5 Flash)' },
            ];
            this.csScreenProcessingModel = new CustomSelect(
                screenModelEl,
                opts,
                this.settings.screenProcessingModel || 'openai',
                async (val) => {
                    const provider = (val as 'openai' | 'google');
                    logger.info('settings', 'Screen processing model changed', { provider });
                    const previous = this.settings.screenProcessingModel || 'openai';
                    try {
                        if (provider === 'openai' && !this.hasOpenAiKey()) {
                            this.showNotification('Add an OpenAI API key before using OpenAI screen processing', 'error');
                            this.csScreenProcessingModel?.setValue(previous);
                            return;
                        }
                        if (provider === 'google' && !this.hasGoogleKey()) {
                            this.showNotification('Add a Google AI API key before using Google screen processing', 'error');
                            this.csScreenProcessingModel?.setValue(previous);
                            return;
                        }
                        await window.api.settings.setScreenProcessingModel(provider);
                        this.updateSettings({ screenProcessingModel: provider });
                        this.settings.screenProcessingModel = provider;
                        this.showNotification(`Screen processing model changed to ${provider === 'openai' ? 'OpenAI' : 'Google'}`);
                    } catch (error) {
                        this.showNotification('Error saving screen processing model', 'error');
                        this.csScreenProcessingModel?.setValue(previous);
                    }
                }
            );
        }

        // API LLM Model
        const llmEl = this.container.querySelector('#llmModel') as HTMLElement | null;
        if (llmEl) {
            const opts: CustomSelectOption[] = [
                { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano (Default - Fast & Efficient)' },
                { value: 'gpt-4o', label: 'GPT-4o (Latest - High Quality)' },
                { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast & Cost-effective)' },
                { value: 'gpt-4-turbo', label: 'GPT-4 Turbo (High Performance)' },
                { value: 'gpt-4', label: 'GPT-4 (Classic High Quality)' },
                { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (Legacy - Fast)' },
                { value: 'gpt-3.5-turbo-16k', label: 'GPT-3.5 Turbo 16K (Extended Context)' },
                { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google - Fast)' },
                { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Google - Advanced)' },
                { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Google - Experimental)' },
                { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (Google - Stable)' },
                { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (Google - Efficient)' },
            ];
            // Определяем начальное значение для API модели
            const currentModel = this.settings.llmModel || 'gpt-4.1-nano';
            const isApiModel = opts.some(opt => opt.value === currentModel);
            const initialValue = isApiModel ? currentModel : 'gpt-4.1-nano';
            
            this.csLlmModel = new CustomSelect(
                llmEl,
                opts,
                initialValue,
                async (val) => {
                    const model = val;
                    logger.info('settings', 'API LLM model changed', { model });
                    const previous = this.settings.llmModel || initialValue;
                    try {
                        const isOpenAiModel = model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o2');
                        const isGoogleModel = model.startsWith('google');
                        if (isOpenAiModel && !this.hasOpenAiKey()) {
                            this.showNotification('Add an OpenAI API key before selecting GPT models', 'error');
                            this.csLlmModel?.setValue(previous);
                            return;
                        }
                        if (isGoogleModel && !this.hasGoogleKey()) {
                            this.showNotification('Add a Google AI API key before selecting Google models', 'error');
                            this.csLlmModel?.setValue(previous);
                            return;
                        }
                        await window.api.settings.setLlmModel(model);
                        this.updateSettings({ llmModel: model });
                        this.settings.llmModel = model;
                        this.showNotification(`API LLM model changed to ${model}`);
                    } catch (error) {
                        this.showNotification('Error saving API LLM model', 'error');
                        this.csLlmModel?.setValue(previous);
                    }
                }
            );
        }

        // Local LLM Model
        const localLlmEl = this.container.querySelector('#localLlmModel') as HTMLElement | null;
        if (localLlmEl) {
            const opts: CustomSelectOption[] = [
                { value: 'gpt-oss:120b', label: 'GPT-OSS 120B (Local)' },
                { value: 'gpt-oss:20b', label: 'GPT-OSS 20B (Local)' },
                { value: 'gemma3:27b', label: 'Gemma 3 27B (Local)' },
                { value: 'gemma3:12b', label: 'Gemma 3 12B (Local)' },
                { value: 'gemma3:4b', label: 'Gemma 3 4B (Local)' },
                { value: 'gemma3:1b', label: 'Gemma 3 1B (Local)' },
                { value: 'deepseek-r1:8b', label: 'DeepSeek-R1 8B (Local)' },
                { value: 'qwen3-coder:30b', label: 'Qwen3-Coder 30B (Local)' },
                { value: 'qwen3:30b', label: 'Qwen3 30B (Local)' },
                { value: 'qwen3:8b', label: 'Qwen3 8B (Local)' },
                { value: 'qwen3:4b', label: 'Qwen3 4B (Local)' },
            ];
            // Определяем начальное значение для локальной модели
            const currentModel = this.settings.llmModel || 'gpt-oss:20b';
            const isLocalModel = opts.some(opt => opt.value === currentModel);
            const initialValue = isLocalModel ? currentModel : 'gpt-oss:20b';
            
            this.csLocalLlmModel = new CustomSelect(
                localLlmEl,
                opts,
                initialValue,
                async (val) => {
                    const model = val;
                    logger.info('settings', 'Local LLM model changed', { model });
                    try {
                        await window.api.settings.setLlmModel(model);
                        this.settings.llmModel = model;
                        this.showNotification(`Local LLM model changed to ${model}`);
                    } catch (error) {
                        this.showNotification('Error saving Local LLM model', 'error');
                    }
                }
            );
        }

        // Audio Input Type
        const aitEl = this.container.querySelector('#audioInputType') as HTMLElement | null;
        if (aitEl) {
            const opts: CustomSelectOption[] = [
                { value: 'microphone', label: 'Microphone' },
                { value: 'system', label: 'System Audio' },
            ];
            this.csAudioInputType = new CustomSelect(
                aitEl,
                opts,
                this.settings.audioInputType || 'microphone',
                async (val) => {
                    const audioType = (val as 'microphone' | 'system');
                    logger.info('settings', 'Audio input type changed', { audioType });
                    try {
                        await window.api.settings.setAudioInputType(audioType);
                        this.updateSettings({ audioInputType: audioType });
                        this.settings.audioInputType = audioType;
                        this.updateAudioTypeVisibility();
                        this.showNotification(`Audio input type changed to ${audioType === 'microphone' ? 'Microphone' : 'System Audio'}`);
                        // notify renderer to refresh in-memory input type immediately
                        try {
                            window.dispatchEvent(new CustomEvent('xexamai:settings-changed', { detail: { key: 'audioInputType', value: audioType } }));
                        } catch {}
                    } catch (error) {
                        this.showNotification('Error saving audio input type', 'error');
                    }
                }
            );
        }

        // Audio Input Device (populated later)
        const aidEl = this.container.querySelector('#audioInputDevice') as HTMLElement | null;
        if (aidEl) {
            this.csAudioInputDevice = new CustomSelect(
                aidEl,
                [{ value: '', label: 'Loading devices...' }],
                this.settings.audioInputDeviceId || '',
                async (val) => {
                    const deviceId = val;
                    logger.info('settings', 'Audio input device changed', { deviceId });
                    try {
                        await window.api.settings.setAudioInputDevice(deviceId);
                        this.updateSettings({ audioInputDeviceId: deviceId });
                        this.settings.audioInputDeviceId = deviceId;
                        this.showNotification('Audio input device saved successfully');
                    } catch (error) {
                        this.showNotification('Error saving audio input device', 'error');
                    }
                }
            );
        }

        // Stream Mode
        const smEl = this.container.querySelector('#streamMode') as HTMLElement | null;
        if (smEl) {
            const opts: CustomSelectOption[] = [
                { value: 'base', label: 'Base' },
                { value: 'stream', label: 'Stream (Real-time Google)' },
            ];
            this.csStreamMode = new CustomSelect(
                smEl,
                opts,
                this.settings.streamMode || 'base',
                async (val) => {
                    const mode = (val as 'base' | 'stream');
                    logger.info('settings', 'Transcription type changed', { mode });
                    const previous = this.settings.streamMode || 'base';
                    try {
                        if (mode === 'stream' && !this.hasGoogleKey()) {
                            this.showNotification('Add a Google AI API key before enabling stream mode', 'error');
                            this.csStreamMode?.setValue(previous);
                            return;
                        }
                        await window.api.settings.setStreamMode(mode);
                        this.updateSettings({ streamMode: mode });
                        this.settings.streamMode = mode;
                        if (mode === 'stream') {
                            if (this.csTranscriptionMode) {
                                this.csTranscriptionMode.setValue('api');
                            }
                            if (this.settings.transcriptionMode !== 'api') {
                                await window.api.settings.setTranscriptionMode('api');
                                this.updateSettings({ transcriptionMode: 'api' });
                                this.settings.transcriptionMode = 'api';
                            }
                        }
                        this.showNotification(`Transcription type changed to ${mode === 'base' ? 'Base' : 'Stream'}`);
                        this.updateTranscriptionModeVisibility();
                        // notify renderer to refresh UI immediately
                        try {
                            window.dispatchEvent(new CustomEvent('xexamai:settings-changed', { detail: { key: 'streamMode', value: mode } }));
                        } catch {}
                    } catch (error) {
                        this.showNotification('Error saving stream mode', 'error');
                        this.csStreamMode?.setValue(previous);
                    }
                }
            );
        }
    }

    private attachEventListeners() {
        const saveApiKeyBtn = this.container.querySelector('#saveApiKey');
        const apiKeyInput = this.container.querySelector('#openaiApiKey') as HTMLInputElement;

        if (saveApiKeyBtn && apiKeyInput) {
            saveApiKeyBtn.addEventListener('click', async () => {
                const key = apiKeyInput.value.trim();
                if (key) {
                    logger.info('settings', 'API key save button clicked');
                    try {
                        await window.api.settings.setOpenaiApiKey(key);
                        this.updateSettings({ openaiApiKey: key });
                        this.settings.openaiApiKey = key;
                        this.showNotification('API Key saved successfully');
                    } catch (error) {
                        this.showNotification('Error saving API Key', 'error');
                    }
                }
            });
        }

        const saveGoogleApiKeyBtn = this.container.querySelector('#saveGoogleApiKey');
        const googleApiKeyInput = this.container.querySelector('#googleApiKey') as HTMLInputElement;

        if (saveGoogleApiKeyBtn && googleApiKeyInput) {
            saveGoogleApiKeyBtn.addEventListener('click', async () => {
                const key = googleApiKeyInput.value.trim();
                if (key) {
                    logger.info('settings', 'Google API key save button clicked');
                    try {
                        await window.api.settings.setGoogleApiKey(key);
                        this.updateSettings({ googleApiKey: key });
                        this.settings.googleApiKey = key;
                        this.showNotification('Google API Key saved successfully');
                    } catch (error) {
                        this.showNotification('Error saving Google API Key', 'error');
                    }
                }
            });
        }

        const opacitySlider = this.container.querySelector('#windowOpacity') as HTMLInputElement;
        const opacityValue = this.container.querySelector('#opacityValue');

        if (opacitySlider && opacityValue) {
            opacitySlider.addEventListener('input', async (e) => {
                const target = e.target as HTMLInputElement;
                const value = parseInt(target.value);
                opacityValue.textContent = `${value}%`;
                logger.info('settings', 'Window opacity changed', { opacity: value });

                try {
                    await window.api.settings.setWindowOpacity(value);
                    this.updateSettings({ windowOpacity: value });
                    this.settings.windowOpacity = value;
                } catch (error) {
                    console.error('Error setting window opacity:', error);
                }
            });
        }

        const scaleSlider = this.container.querySelector('#windowScale') as HTMLInputElement;
        const scaleValue = this.container.querySelector('#scaleValue');
        const scaleRestartNote = this.container.querySelector('#scaleRestartNote') as HTMLElement | null;

        if (scaleSlider && scaleValue) {
            scaleSlider.addEventListener('input', async (e) => {
                const target = e.target as HTMLInputElement;
                const value = parseFloat(target.value);
                scaleValue.textContent = `${value}x`;
                logger.info('settings', 'Window scale changed', { scale: value });

                try {
                    await window.api.settings.setWindowScale(value);
                    this.updateSettings({ windowScale: value });
                    this.settings.windowScale = value;
                    if (scaleRestartNote) {
                        const changed = Math.abs((this.initialWindowScale || 1.0) - value) > 1e-9;
                        scaleRestartNote.style.display = changed ? 'block' : 'none';
                    }
                } catch (error) {
                    console.error('Error setting window scale:', error);
                    this.showNotification('Error saving window scale', 'error');
                }
            });
        }

        const addDurationBtn = this.container.querySelector('#addDuration');
        const newDurationInput = this.container.querySelector('#newDuration') as HTMLInputElement;

        if (addDurationBtn && newDurationInput) {
            addDurationBtn.addEventListener('click', async () => {
                const duration = parseInt(newDurationInput.value);
                if (duration && duration > 0 && duration <= 300) {
                    logger.info('settings', 'Duration add button clicked', { duration });
                    const newDurations = [...(this.settings.durations || []), duration].sort((a, b) => a - b);
                    try {
                        await window.api.settings.setDurations(newDurations);
                        this.updateSettings({ durations: newDurations });
                        this.settings.durations = newDurations;
                        this.renderDurations();
                        newDurationInput.value = '';
                        this.showNotification('Duration added successfully');
                        this.options.onDurationsChange?.(newDurations);
                    } catch (error) {
                        this.showNotification('Error adding duration', 'error');
                    }
                }
            });
        }

        this.container.addEventListener('click', async (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.remove-duration')) {
                const button = target.closest('.remove-duration') as HTMLElement;
                const duration = parseInt(button.dataset.duration || '0');
                logger.info('settings', 'Duration remove button clicked', { duration });
                const newDurations = (this.settings.durations || []).filter((d: number) => d !== duration);

                try {
                    await window.api.settings.setDurations(newDurations);
                    this.updateSettings({ durations: newDurations });
                    this.updateSettings({ durations: newDurations });
                    this.settings.durations = newDurations;
                    this.renderDurations();
                    this.showNotification('Duration removed successfully');
                    this.options.onDurationsChange?.(newDurations);
                } catch (error) {
                    this.showNotification('Error removing duration', 'error');
                }
            }
            if (target.closest('.save-hotkey')) {
                const button = target.closest('.save-hotkey') as HTMLElement;
                const duration = parseInt(button.dataset.duration || '0');
                const input = this.container.querySelector(`.hotkey-input[data-duration="${duration}"]`) as HTMLInputElement | null;
                const raw = (input?.value || '').trim();
                if (!raw) return;
                const key = raw[0];
                const next = Object.assign({}, (this.settings as any).durationHotkeys || {});
                next[duration] = key.toLowerCase();
                logger.info('settings', 'Save duration hotkey clicked', { duration, key });
                try {
                    await (window.api.settings as any).setDurationHotkeys(next);
                    this.updateSettings({ durationHotkeys: next });
                    (this.settings as any).durationHotkeys = next;
                    this.options.onHotkeysChange?.(next);
                    this.showNotification('Hotkey saved');
                } catch (error) {
                    this.showNotification('Error saving hotkey', 'error');
                }
            }
            if (target.id === 'saveToggleInputHotkey') {
                const input = this.container.querySelector('#toggleInputHotkey') as HTMLInputElement | null;
                const raw = (input?.value || '').trim();
                const key = (raw || 'g')[0];
                if (!key) return;
                try {
                    await (window.api.settings as any).setToggleInputHotkey(key);
                    this.updateSettings({ toggleInputHotkey: key });
                    (this.settings as any).toggleInputHotkey = key.toLowerCase();
                    this.showNotification('Hotkey saved');
                } catch (error) {
                    this.showNotification('Error saving hotkey', 'error');
                }
            }
            if (target.id === 'saveStreamSendHotkey') {
                const input = this.container.querySelector('#streamSendHotkey') as HTMLInputElement | null;
                const raw = (input?.value || '').trim();
                const key = (raw || '~')[0];
                if (!key) return;
                try {
                    await (window.api.settings as any).setStreamSendHotkey(key);
                    this.updateSettings({ streamSendHotkey: key });
                    (this.settings as any).streamSendHotkey = key;
                    this.showNotification('Stream send hotkey saved');
                    // notify renderer so the keydown handler updates without restart
                    try {
                        window.dispatchEvent(new CustomEvent('xexamai:settings-changed', { detail: { key: 'streamSendHotkey', value: key } }));
                    } catch {}
                } catch (error) {
                    this.showNotification('Error saving stream send hotkey', 'error');
                }
            }
        });

        // custom selects events are wired in initCustomSelects()

        const saveTranscriptionPromptBtn = this.container.querySelector('#saveTranscriptionPrompt');
        const transcriptionPromptTextarea = this.container.querySelector('#transcriptionPrompt') as HTMLTextAreaElement;

        if (saveTranscriptionPromptBtn && transcriptionPromptTextarea) {
            saveTranscriptionPromptBtn.addEventListener('click', async () => {
                const prompt = transcriptionPromptTextarea.value.trim();
                logger.info('settings', 'Transcription prompt save button clicked', { promptLength: prompt.length });
                try {
                    await window.api.settings.setTranscriptionPrompt(prompt);
                    this.updateSettings({ transcriptionPrompt: prompt });
                    this.settings.transcriptionPrompt = prompt;
                    this.showNotification('Transcription prompt saved successfully');
                } catch (error) {
                    this.showNotification('Error saving transcription prompt', 'error');
                }
            });
        }

        const saveLlmPromptBtn = this.container.querySelector('#saveLlmPrompt');
        const llmPromptTextarea = this.container.querySelector('#llmPrompt') as HTMLTextAreaElement;

        if (saveLlmPromptBtn && llmPromptTextarea) {
            saveLlmPromptBtn.addEventListener('click', async () => {
                const prompt = llmPromptTextarea.value.trim();
                logger.info('settings', 'LLM prompt save button clicked', { promptLength: prompt.length });
                try {
                    await window.api.settings.setLlmPrompt(prompt);
                    this.updateSettings({ llmPrompt: prompt });
                    this.settings.llmPrompt = prompt;
                    this.showNotification('LLM prompt saved successfully');
                } catch (error) {
                    this.showNotification('Error saving LLM prompt', 'error');
                }
            });
        }

        const saveScreenPromptBtn = this.container.querySelector('#saveScreenProcessingPrompt');
        const screenPromptTextarea = this.container.querySelector('#screenProcessingPrompt') as HTMLTextAreaElement;
        if (saveScreenPromptBtn && screenPromptTextarea) {
            saveScreenPromptBtn.addEventListener('click', async () => {
                const prompt = screenPromptTextarea.value.trim();
                logger.info('settings', 'Screen processing prompt save button clicked', { promptLength: prompt.length });
                try {
                    await window.api.settings.setScreenProcessingPrompt(prompt);
                    this.updateSettings({ screenProcessingPrompt: prompt });
                    this.settings.screenProcessingPrompt = prompt;
                    this.showNotification('Screen processing prompt saved successfully');
                } catch (error) {
                    this.showNotification('Error saving screen processing prompt', 'error');
                }
            });
        }

        // audio input device change handled in initCustomSelects()

        const refreshDevicesBtn = this.container.querySelector('#refreshDevices');
        if (refreshDevicesBtn) {
            refreshDevicesBtn.addEventListener('click', async () => {
                logger.info('settings', 'Audio devices refresh button clicked');
                await this.loadAudioDevices();
                this.showNotification('Audio devices refreshed');
            });
        }

        const alwaysOnTopCheckbox = this.container.querySelector('#alwaysOnTop') as HTMLInputElement;
        if (alwaysOnTopCheckbox) {
            alwaysOnTopCheckbox.addEventListener('change', async () => {
                const alwaysOnTop = alwaysOnTopCheckbox.checked;
                logger.info('settings', 'Always on top changed', { alwaysOnTop });
                try {
                    await window.api.settings.setAlwaysOnTop(alwaysOnTop);
                    this.updateSettings({ alwaysOnTop });
                    this.settings.alwaysOnTop = alwaysOnTop;
                    
                    // Показываем более информативное уведомление
                    if (alwaysOnTop) {
                        this.showNotification('Always on top enabled. Note: Some fullscreen apps may still cover this window.');
                    } else {
                        this.showNotification('Always on top disabled');
                    }
                } catch (error) {
                    logger.error('settings', 'Failed to set always on top', { error });
                    this.showNotification('Error saving always on top setting. Check console for details.', 'error');
                }
            });
        }

        const hideAppCheckbox = this.container.querySelector('#hideApp') as HTMLInputElement;
        if (hideAppCheckbox) {
            hideAppCheckbox.addEventListener('change', async () => {
                const hideApp = hideAppCheckbox.checked;
                logger.info('settings', 'Hide app changed', { hideApp });
                try {
                    await window.api.settings.setHideApp(hideApp);
                    this.updateSettings({ hideApp });
                    this.settings.hideApp = hideApp;
                    
                    if (hideApp) {
                        this.showNotification('App will be hidden from screen recording and demonstrations');
                    } else {
                        this.showNotification('App will be visible in screen recording and demonstrations');
                    }
                } catch (error) {
                    logger.error('settings', 'Failed to set hide app', { error });
                    this.showNotification('Error saving hide app setting. Check console for details.', 'error');
                }
            });
        }

        const openConfigFolderBtn = this.container.querySelector('#openConfigFolder');
        if (openConfigFolderBtn) {
            openConfigFolderBtn.addEventListener('click', async () => {
                logger.info('settings', 'Open config folder button clicked');
                try {
                    await window.api.settings.openConfigFolder();
                } catch (error) {
                    this.showNotification('Error opening config folder', 'error');
                }
            });
        }

        // API Timeouts
        const apiSttInput = this.container.querySelector('#apiSttTimeoutMs') as HTMLInputElement;
        const apiLlmInput = this.container.querySelector('#apiLlmTimeoutMs') as HTMLInputElement;
        const screenTimeoutInput = this.container.querySelector('#screenProcessingTimeoutMs') as HTMLInputElement;

        const saveApiSttBtn = this.container.querySelector('#saveApiSttTimeout');
        if (saveApiSttBtn && apiSttInput) {
            saveApiSttBtn.addEventListener('click', async () => {
                const val = Math.max(1000, Math.min(600000, Math.floor(parseInt(apiSttInput.value || '0'))));
                try {
                    await (window.api.settings as any).setApiSttTimeoutMs(val);
                    this.updateSettings({ apiSttTimeoutMs: val });
                    (this.settings as any).apiSttTimeoutMs = val;
                    this.showNotification('Transcription API timeout saved');
                } catch (error) {
                    this.showNotification('Error saving Transcription API timeout', 'error');
                }
            });
        }

        const saveApiLlmBtn = this.container.querySelector('#saveApiLlmTimeout');
        if (saveApiLlmBtn && apiLlmInput) {
            saveApiLlmBtn.addEventListener('click', async () => {
                const val = Math.max(1000, Math.min(600000, Math.floor(parseInt(apiLlmInput.value || '0'))));
                try {
                    await (window.api.settings as any).setApiLlmTimeoutMs(val);
                    this.updateSettings({ apiLlmTimeoutMs: val });
                    (this.settings as any).apiLlmTimeoutMs = val;
                    this.showNotification('LLM API timeout saved');
                } catch (error) {
                    this.showNotification('Error saving LLM API timeout', 'error');
                }
            });
        }

        const saveScreenTimeoutBtn = this.container.querySelector('#saveScreenProcessingTimeout');
        if (saveScreenTimeoutBtn && screenTimeoutInput) {
            saveScreenTimeoutBtn.addEventListener('click', async () => {
                const val = Math.max(1000, Math.min(600000, Math.floor(parseInt(screenTimeoutInput.value || '0'))));
                try {
                    await window.api.settings.setScreenProcessingTimeoutMs(val);
                    this.updateSettings({ screenProcessingTimeoutMs: val });
                    (this.settings as any).screenProcessingTimeoutMs = val;
                    this.showNotification('Screen processing timeout saved');
                } catch (error) {
                    this.showNotification('Error saving screen processing timeout', 'error');
                }
            });
        }

        const saveWindowSizeBtn = this.container.querySelector('#saveWindowSize');
        const windowWidthInput = this.container.querySelector('#windowWidth') as HTMLInputElement;
        const windowHeightInput = this.container.querySelector('#windowHeight') as HTMLInputElement;
        if (saveWindowSizeBtn && windowWidthInput && windowHeightInput) {
            saveWindowSizeBtn.addEventListener('click', async () => {
                const width = Math.max(400, Math.floor(parseInt(windowWidthInput.value || '0')));
                const height = Math.max(700, Math.floor(parseInt(windowHeightInput.value || '0')));
                logger.info('settings', 'Save window size clicked', { width, height });
                try {
                    await window.api.settings.setWindowSize({ width, height });
                    this.updateSettings({ windowWidth: width, windowHeight: height });
                    this.settings.windowWidth = width;
                    this.settings.windowHeight = height;
                    this.showNotification('Window size saved');
                } catch (error) {
                    this.showNotification('Error saving window size', 'error');
                }
            });
        }
    }

    private showNotification(message: string, type: 'success' | 'error' = 'success') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${type === 'success' ? '#10b981' : '#ef4444'};
            color: white;
            padding: 12px 16px;
            border-radius: 6px;
            font-size: 14px;
            z-index: 1000;
            opacity: 0;
            transform: translateX(100%);
            transition: all 0.3s ease;
        `;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.opacity = '1';
            notification.style.transform = 'translateX(0)';
        }, 10);

        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 3000);
    }
}
