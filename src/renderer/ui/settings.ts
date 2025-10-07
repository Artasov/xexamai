import type {AppSettings} from '../types.js';
import {logger} from '../utils/logger.js';

type CustomSelectOption = { value: string; label: string; title?: string };

class CustomSelect {
    private container: HTMLElement;
    private button: HTMLButtonElement;
    private list: HTMLDivElement;
    private options: CustomSelectOption[] = [];
    private value: string = '';
    private onChange?: (value: string) => void;
    private isOpen: boolean = false;

    constructor(container: HTMLElement, options: CustomSelectOption[], initialValue: string, onChange?: (value: string) => void) {
        this.container = container;
        this.onChange = onChange;
        this.button = document.createElement('button');
        this.button.type = 'button';
        this.button.className = 'input-field frbc gap-2 relative';
        this.button.setAttribute('aria-haspopup', 'listbox');
        this.button.setAttribute('aria-expanded', 'false');

        const chevron = document.createElement('span');
        chevron.textContent = '▾';
        chevron.className = 'text-gray-400';

        this.list = document.createElement('div');
        this.list.className = 'bg-gray-800 border border-gray-700 rounded shadow-lg';
        this.list.setAttribute('role', 'listbox');
        // Render as portal to body to avoid clipping and stacking issues
        this.list.style.position = 'fixed';
        this.list.style.top = '-1000px';
        this.list.style.left = '-1000px';
        this.list.style.maxHeight = '60vh';
        this.list.style.overflow = 'auto';
        this.list.style.zIndex = '2147483647';
        this.list.style.display = 'none';

        const wrap = document.createElement('div');
        wrap.className = 'relative w-full';
        wrap.appendChild(this.button);
        this.container.innerHTML = '';
        this.container.appendChild(wrap);
        document.body.appendChild(this.list);

        this.setOptions(options);
        this.setValue(initialValue);

        this.button.addEventListener('click', () => this.toggle());
        document.addEventListener('click', (e) => {
            if (!this.container.contains(e.target as Node)) this.close();
        });
        window.addEventListener('resize', () => this.repositionIfOpen());
        window.addEventListener('scroll', () => this.repositionIfOpen(), true);
    }

    public setOptions(options: CustomSelectOption[]) {
        this.options = options || [];
        this.list.innerHTML = '';
        this.options.forEach((opt) => {
            const item = document.createElement('div');
            item.className = 'px-3 py-2 hover:bg-gray-700 cursor-pointer';
            item.textContent = opt.label;
            if (opt.title) item.title = opt.title;
            item.setAttribute('role', 'option');
            item.dataset.value = opt.value;
            item.addEventListener('click', () => {
                this.setValue(opt.value);
                this.onChange?.(opt.value);
                this.close();
            });
            this.list.appendChild(item);
        });
        this.updateButtonLabel();
    }

    public setValue(value: string) {
        this.value = value;
        this.updateButtonLabel();
    }

    public getValue(): string {
        return this.value;
    }

    private updateButtonLabel() {
        const current = this.options.find((o) => o.value === this.value) || this.options[0];
        const label = current ? current.label : '';
        this.button.textContent = label || '';
        // add chevron back (textContent replaced it)
        const chevron = document.createElement('span');
        chevron.textContent = '▾';
        chevron.className = 'ml-2 text-gray-400';
        this.button.appendChild(chevron);
    }

    private toggle() {
        if (this.isOpen) this.close(); else this.open();
    }

    private open() {
        this.reposition();
        this.list.style.display = 'block';
        this.button.setAttribute('aria-expanded', 'true');
        this.isOpen = true;
    }

    private close() {
        this.list.style.display = 'none';
        this.button.setAttribute('aria-expanded', 'false');
        this.isOpen = false;
    }

    private repositionIfOpen() {
        if (!this.isOpen) return;
        this.reposition();
    }

    private reposition() {
        try {
            const rect = this.button.getBoundingClientRect();
            const margin = 4;
            const top = rect.bottom + margin;
            const left = rect.left;
            const width = rect.width;
            this.list.style.top = `${Math.max(0, Math.floor(top))}px`;
            this.list.style.left = `${Math.max(0, Math.floor(left))}px`;
            this.list.style.minWidth = `${Math.max(140, Math.floor(width))}px`;
            this.list.style.maxWidth = `${Math.max(140, Math.floor(Math.min(window.innerWidth - left - 8, 560)))}px`;
        } catch {}
    }
}

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
    };
    private panelType: 'general' | 'ai' | 'audio' | 'hotkeys' = 'general';

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

    constructor(container: HTMLElement, options: SettingsPanelOptions = {}) {
        this.container = container;
        this.options = options;
        this.panelType = options.panelType || 'general';
        this.init().then();
    }

    private async init() {
        try {
            this.settings = await window.api.settings.get();
        } catch (error) {
            console.error('Error loading settings:', error);
        }

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
    }

    private renderGeneralSections(): string {
        if (this.panelType !== 'general') return '';
        
        return `
                <div class="settings-section">
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
                            <span class="text-xs text-gray-400">Gemeni</span>
                            <input 
                                type="password" 
                                id="geminiApiKey" 
                                class="input-field" 
                                placeholder="Enter your Gemini API key"
                                value="${this.settings.geminiApiKey || ''}"
                            />
                            <button id="saveGeminiApiKey" class="btn btn-sm">Save</button>
                        </div>
                    </div>
                </div>

                <div class="settings-section">
                    <h3 class="settings-title">Window behavior</h3>
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
                </div>

                <div class="settings-section fc gap-2">
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

                <div class="settings-section">
                    <h3 class="settings-title">Config Folder</h3>
                    <button id="openConfigFolder" class="btn btn-secondary fr gap-2">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 0-2-2z"/>
                            <path d="M8 21v-4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4"/>
                        </svg>
                        Open Config Folder
                    </button>
                </div>
        `;
    }

    private renderAiSections(): string {
        if (this.panelType !== 'ai') return '';
        
        return `
                <div class="settings-section fc">
                    <h3 class="settings-title">Mode</h3>
                    <div class="fr gap-1">
                        <div class="fc gap-1">
                            <h3 class="text-xs text-gray-400">Transcription</h3>
                            <div id="transcriptionMode" class="min-w-[100px]"></div>
                        </div>
                        <div class="fc gap-1">
                            <h3 class="text-xs text-gray-400">LLM</h3>
                            <div id="llmHost" class="min-w-[100px]"></div>
                        </div>
                        <div class="fc gap-1">
                            <h3 class="text-xs text-gray-400">Stream Mode</h3>
                            <div id="streamMode" class="min-w-[100px]"></div>
                        </div>
                    </div>
                </div>
                
                <div class="settings-section fc">
                    <h3 class="settings-title">Model</h3>
                    
                    <div class="fr gap-2 flex-wrap">
                        <div class="fc gap-1">
                            <div class="fc gap-1" id="apiTranscriptionSection">
                                <div class="fc">
                                    <h3 class="text-xs text-gray-400">Transcription</h3>
                                    <div id="transcriptionModel"></div>
                                </div>
                            </div>
                            <div class="fc gap-1" id="localTranscriptionSection" style="display: none;">
                                <h3 class="text-xs text-gray-400">Transcription</h3>
                                <div id="localWhisperModel"></div>
                            </div>
                            <div class="fc gap-1" id="localDeviceSection" style="display: none;">
                                <h3 class="text-xs text-gray-400">Local transcription device</h3>
                                <div id="localDevice"></div>
                            </div>
                        </div>
                        
                        <div class="fr gap-1">
                            <div class="fc gap-1" id="apiLlmSection">
                                <div class="fc gap-1">
                                    <h3 class="text-xs text-gray-400">LLM Model</h3>
                                    <div id="llmModel"></div>
                                </div>
                            </div>
                            <div class="fc gap-1" id="localLlmSection" style="display: none;">
                                <h3 class="text-xs text-gray-400">LLM Model</h3>
                                <div id="localLlmModel"></div>
                            </div>
                        </div>
                    </div>
                    
                </div>
                
                <div class="settings-section fc">
                    <h3 class="settings-title">Promt</h3>
                    
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
                    </div>
                    
                </div>


                <div class="settings-section">
                    <h3 class="settings-title">API timeouts</h3>
                    <div class="frbc gap-2">
                        <div class="fc gap-1" style="width:48%">
                            <label class="text-xs text-gray-400">Transcription (ms)</label>
                            <input id="apiSttTimeoutMs" type="number" class="input-field" min="1000" max="600000" step="500" />
                            <button id="saveApiSttTimeout" class="btn btn-sm">Save</button>
                        </div>
                        <div class="fc gap-1" style="width:48%">
                            <label class="text-xs text-gray-400">LLM (ms)</label>
                            <input id="apiLlmTimeoutMs" type="number" class="input-field" min="1000" max="600000" step="500" />
                            <button id="saveApiLlmTimeout" class="btn btn-sm">Save</button>
                        </div>
                    </div>
                </div>
        `;
    }

    private renderAudioSections(): string {
        if (this.panelType !== 'audio') return '';
        
        return `
                <div class="settings-section">
                    <h3 class="settings-title">Audio input</h3>
                    <div id="audioInputType"></div>
                </div>

                <div class="settings-section fc" id="microphoneSection">
                    <h3 class="settings-title">Microphone device</h3>
                    <div class="fr gap-2">
                        <div id="audioInputDevice"></div>
                        <button id="refreshDevices" class="btn btn-sm">Refresh</button>
                    </div>
                </div>
        `;
    }

    private renderHotkeysSections(): string {
        if (this.panelType !== 'hotkeys') return '';
        
        return `
                <div class="settings-section">
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

                <div class="settings-section">
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

                <div class="settings-section">
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
            const modeVal = this.csTranscriptionMode?.getValue() || this.settings.transcriptionMode || 'api';
            const isLocal = modeVal === 'local';
            apiSection.style.display = isLocal ? 'none' : 'flex';
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
                    title="Укажите символ для Ctrl-<ключ>"
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
                    try {
                        await window.api.settings.setTranscriptionMode(mode);
                        this.settings.transcriptionMode = mode;
                        this.updateTranscriptionModeVisibility();
                        this.showNotification(`Transcription mode changed to ${mode === 'api' ? 'API' : 'Local'}`);
                    } catch (error) {
                        this.showNotification('Error saving transcription mode', 'error');
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
                    try {
                        await window.api.settings.setTranscriptionModel(model);
                        this.settings.transcriptionModel = model;
                        this.showNotification(`Transcription model changed to ${model}`);
                    } catch (error) {
                        this.showNotification('Error saving transcription model', 'error');
                    }
                }
            );
        }

        // Local Whisper Model
        const lwmEl = this.container.querySelector('#localWhisperModel') as HTMLElement | null;
        if (lwmEl) {
            const opts: CustomSelectOption[] = [
                { value: 'tiny', label: 'Tiny (~39 MB) - Быстрая, но менее точная' },
                { value: 'base', label: 'Base (~74 MB) - Баланс скорости и точности' },
                { value: 'small', label: 'Small (~244 MB) - Хорошая точность' },
                { value: 'medium', label: 'Medium (~769 MB) - Высокая точность' },
                { value: 'large', label: 'Large (~1550 MB) - Очень высокая точность' },
                { value: 'large-v2', label: 'Large V2 (~1550 MB) - Улучшенная версия Large' },
                { value: 'large-v3', label: 'Large V3 (~1550 MB) - Последняя версия Large' },
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
                { value: 'cpu', label: 'CPU - Стабильная работа, медленнее' },
                { value: 'gpu', label: 'GPU - Быстрее, требует CUDA/OpenCL' },
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
                    try {
                        await window.api.settings.setLlmHost(host);
                        this.settings.llmHost = host;
                        this.updateLlmHostVisibility();
                        
                        // Автоматически переключаем на подходящую модель по умолчанию
                        const defaultModel = host === 'api' ? 'gpt-4.1-nano' : 'gpt-oss:20b';
                        await window.api.settings.setLlmModel(defaultModel);
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
                    try {
                        await window.api.settings.setLlmModel(model);
                        this.settings.llmModel = model;
                        this.showNotification(`API LLM model changed to ${model}`);
                    } catch (error) {
                        this.showNotification('Error saving API LLM model', 'error');
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
                { value: 'base', label: 'Base (Current behavior)' },
                { value: 'stream', label: 'Stream (Real-time Gemini)' },
            ];
            this.csStreamMode = new CustomSelect(
                smEl,
                opts,
                this.settings.streamMode || 'base',
                async (val) => {
                    const mode = (val as 'base' | 'stream');
                    logger.info('settings', 'Stream mode changed', { mode });
                    try {
                        await window.api.settings.setStreamMode(mode);
                        this.settings.streamMode = mode;
                        this.showNotification(`Stream mode changed to ${mode === 'base' ? 'Base' : 'Stream'}`);
                        // notify renderer to refresh UI immediately
                        try {
                            window.dispatchEvent(new CustomEvent('xexamai:settings-changed', { detail: { key: 'streamMode', value: mode } }));
                        } catch {}
                    } catch (error) {
                        this.showNotification('Error saving stream mode', 'error');
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
                        this.settings.openaiApiKey = key;
                        this.showNotification('API Key saved successfully');
                    } catch (error) {
                        this.showNotification('Error saving API Key', 'error');
                    }
                }
            });
        }

        const saveGeminiApiKeyBtn = this.container.querySelector('#saveGeminiApiKey');
        const geminiApiKeyInput = this.container.querySelector('#geminiApiKey') as HTMLInputElement;

        if (saveGeminiApiKeyBtn && geminiApiKeyInput) {
            saveGeminiApiKeyBtn.addEventListener('click', async () => {
                const key = geminiApiKeyInput.value.trim();
                if (key) {
                    logger.info('settings', 'Gemini API key save button clicked');
                    try {
                        await window.api.settings.setGeminiApiKey(key);
                        this.settings.geminiApiKey = key;
                        this.showNotification('Gemini API Key saved successfully');
                    } catch (error) {
                        this.showNotification('Error saving Gemini API Key', 'error');
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
                    this.settings.windowOpacity = value;
                } catch (error) {
                    console.error('Error setting window opacity:', error);
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
                    this.settings.llmPrompt = prompt;
                    this.showNotification('LLM prompt saved successfully');
                } catch (error) {
                    this.showNotification('Error saving LLM prompt', 'error');
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
        if (apiSttInput) apiSttInput.value = String((this.settings as any).apiSttTimeoutMs || 10000);
        if (apiLlmInput) apiLlmInput.value = String((this.settings as any).apiLlmTimeoutMs || 10000);

        const saveApiSttBtn = this.container.querySelector('#saveApiSttTimeout');
        if (saveApiSttBtn && apiSttInput) {
            saveApiSttBtn.addEventListener('click', async () => {
                const val = Math.max(1000, Math.min(600000, Math.floor(parseInt(apiSttInput.value || '0'))));
                try {
                    await (window.api.settings as any).setApiSttTimeoutMs(val);
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
                    (this.settings as any).apiLlmTimeoutMs = val;
                    this.showNotification('LLM API timeout saved');
                } catch (error) {
                    this.showNotification('Error saving LLM API timeout', 'error');
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
