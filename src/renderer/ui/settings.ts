import type {AppSettings} from '../types.js';
import {logger} from '../utils/logger.js';

export interface SettingsPanelOptions {
    onSettingsChange?: (settings: AppSettings) => void;
    onDurationsChange?: (durations: number[]) => void;
    onHotkeysChange?: (map: Record<number, string>) => void;
}

export class SettingsPanel {
    private container: HTMLElement;
    private options: SettingsPanelOptions;
    private settings: AppSettings = {
        durations: [5, 10, 15, 20, 30, 60],
        windowOpacity: 100,
    };

    constructor(container: HTMLElement, options: SettingsPanelOptions = {}) {
        this.container = container;
        this.options = options;
        this.init().then();
    }

    private async init() {
        try {
            this.settings = await window.api.settings.get();
        } catch (error) {
            console.error('Error loading settings:', error);
        }

        this.render();
        this.attachEventListeners();
        await this.loadAudioDevices();
        this.updateAudioTypeVisibility();
        this.updateTranscriptionModeVisibility();
    }

    private render() {
        this.container.innerHTML = `
            <div class="settings-panel">
                <div class="settings-section">
                    <h3 class="settings-title">OpenAI API Key</h3>
                    <div class="input-group">
                        <input 
                            type="password" 
                            id="openaiApiKey" 
                            class="input-field" 
                            placeholder="Enter your OpenAI API key"
                            value="${this.settings.openaiApiKey || ''}"
                        />
                        <button id="saveApiKey" class="btn btn-sm">Save</button>
                    </div>
                </div>

                <div class="settings-section">
                    <h3 class="settings-title">Window Opacity</h3>
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

                <div class="settings-section">
                    <h3 class="settings-title">Window Behavior</h3>
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
                </div>

                <div class="settings-section">
                    <h3 class="settings-title">Window Size on Startup</h3>
                    <div class="fc gap-2">
                        <div class="fc gap-1">
                            <label for="windowWidth" class="text-xs text-gray-400">Width (min 400)</label>
                            <input 
                                type="number" 
                                id="windowWidth" 
                                class="input-field" 
                                min="400" 
                                value="${Math.max(400, this.settings.windowWidth || 420)}"
                            />
                        </div>
                        <div class="fc gap-1">
                            <label for="windowHeight" class="text-xs text-gray-400">Height (min 700)</label>
                            <input 
                                type="number" 
                                id="windowHeight" 
                                class="input-field" 
                                min="700" 
                                value="${Math.max(700, this.settings.windowHeight || 780)}"
                            />
                        </div>
                        <button id="saveWindowSize" class="btn btn-sm">Save</button>
                    </div>
                </div>

                <div class="settings-section">
                    <h3 class="settings-title">Transcription Mode</h3>
                    <div class="input-group">
                        <select id="transcriptionMode" class="input-field">
                            <option value="api">API</option>
                            <option value="local">Local</option>
                        </select>
                    </div>
                </div>

                <div class="settings-section" id="apiTranscriptionSection">
                    <h3 class="settings-title">API Transcription Model</h3>
                    <div class="input-group">
                        <select id="transcriptionModel" class="input-field">
                            <option value="gpt-4o-mini-transcribe">GPT-4o Mini Transcribe (Default)</option>
                            <option value="whisper-1">Whisper-1 (Balanced)</option>
                            <option value="gpt-4o-transcribe">GPT-4o Transcribe (High Quality)</option>
                        </select>
                    </div>
                </div>

                <div class="settings-section" id="localTranscriptionSection" style="display: none;">
                    <h3 class="settings-title">Local Whisper Model</h3>
                    <div class="input-group">
                        <select id="localWhisperModel" class="input-field">
                            <option value="tiny">Tiny (~39 MB) - Быстрая, но менее точная</option>
                            <option value="base">Base (~74 MB) - Баланс скорости и точности</option>
                            <option value="small">Small (~244 MB) - Хорошая точность</option>
                            <option value="medium">Medium (~769 MB) - Высокая точность</option>
                            <option value="large">Large (~1550 MB) - Очень высокая точность</option>
                            <option value="large-v2">Large V2 (~1550 MB) - Улучшенная версия Large</option>
                            <option value="large-v3">Large V3 (~1550 MB) - Последняя версия Large</option>
                        </select>
                    </div>
                </div>

                <div class="settings-section" id="localDeviceSection" style="display: none;">
                    <h3 class="settings-title">Local Device</h3>
                    <div class="input-group">
                        <select id="localDevice" class="input-field">
                            <option value="cpu">CPU - Стабильная работа, медленнее</option>
                            <option value="gpu">GPU - Быстрее, требует CUDA/OpenCL</option>
                        </select>
                    </div>
                </div>

                <div class="settings-section">
                    <h3 class="settings-title">LLM Model</h3>
                    <div class="input-group">
                        <select id="llmModel" class="input-field">
                            <option value="gpt-4.1-nano">GPT-4.1 Nano (Default - Fast & Efficient)</option>
                            <option value="gpt-4o">GPT-4o (Latest - High Quality)</option>
                            <option value="gpt-4o-mini">GPT-4o Mini (Fast & Cost-effective)</option>
                            <option value="gpt-4-turbo">GPT-4 Turbo (High Performance)</option>
                            <option value="gpt-4">GPT-4 (Classic High Quality)</option>
                            <option value="gpt-3.5-turbo">GPT-3.5 Turbo (Legacy - Fast)</option>
                            <option value="gpt-3.5-turbo-16k">GPT-3.5 Turbo 16K (Extended Context)</option>
                            <option value="gpt-oss:120b">GPT-OSS 120B (Local)</option>
                            <option value="gpt-oss:20b">GPT-OSS 20B (Local)</option>
                            <option value="gemma3:27b">Gemma 3 27B (Local)</option>
                            <option value="gemma3:12b">Gemma 3 12B (Local)</option>
                            <option value="gemma3:4b">Gemma 3 4B (Local)</option>
                            <option value="gemma3:1b">Gemma 3 1B (Local)</option>
                            <option value="deepseek-r1:8b">DeepSeek-R1 8B (Local)</option>
                            <option value="qwen3-coder:30b">Qwen3-Coder 30B (Local)</option>
                            <option value="qwen3:30b">Qwen3 30B (Local)</option>
                            <option value="qwen3:8b">Qwen3 8B (Local)</option>
                            <option value="qwen3:4b">Qwen3 4B (Local)</option>
                        </select>
                    </div>
                </div>

                <div class="settings-section">
                    <h3 class="settings-title">Transcription Prompt</h3>
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

                <div class="settings-section">
                    <h3 class="settings-title">LLM Prompt</h3>
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

                <div class="settings-section">
                    <h3 class="settings-title">Audio Input Type</h3>
                    <div class="input-group">
                        <select id="audioInputType" class="input-field">
                            <option value="microphone">Microphone</option>
                            <option value="system">System Audio</option>
                        </select>
                    </div>
                </div>

                <div class="settings-section" id="microphoneSection">
                    <h3 class="settings-title">Microphone Device</h3>
                    <div class="input-group">
                        <select id="audioInputDevice" class="input-field">
                            <option value="">Loading devices...</option>
                        </select>
                        <button id="refreshDevices" class="btn btn-sm">Refresh</button>
                    </div>
                </div>

                <div class="settings-section">
                    <h3 class="settings-title">Recording Durations</h3>
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
                    <h3 class="settings-title">Hotkey: Toggle Audio Input</h3>
                    <div class="fc gap-2">
                        <div class="frs gap-2">
                            <label class="input-label" for="toggleInputHotkey">Ctrl-</label>
                            <input id="toggleInputHotkey" class="input-field w-24" maxlength="1" placeholder="G" value="${(this.settings as any).toggleInputHotkey || 'g'}" />
                            <button id="saveToggleInputHotkey" class="btn btn-sm">Save</button>
                        </div>
                        <div class="text-xs text-gray-400">Single letter or digit, used with Ctrl (e.g., Ctrl-G)</div>
                    </div>
                </div>

                <div class="settings-section">
                    <h3 class="settings-title">Config Folder</h3>
                    <button id="openConfigFolder" class="btn btn-secondary">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 0-2-2z"/>
                            <path d="M8 21v-4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4"/>
                        </svg>
                        Open Config Folder
                    </button>
                </div>

                <div class="settings-section">
                    <h3 class="settings-title">API Timeouts</h3>
                    <div class="frbc gap-2">
                        <div class="fc gap-1" style="width:48%">
                            <label class="input-label">Transcription API timeout (ms)</label>
                            <input id="apiSttTimeoutMs" type="number" class="input-field" min="1000" max="600000" step="500" />
                            <button id="saveApiSttTimeout" class="btn btn-sm">Save</button>
                        </div>
                        <div class="fc gap-1" style="width:48%">
                            <label class="input-label">LLM API timeout (ms)</label>
                            <input id="apiLlmTimeoutMs" type="number" class="input-field" min="1000" max="600000" step="500" />
                            <button id="saveApiLlmTimeout" class="btn btn-sm">Save</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.renderDurations();
    }

    private updateAudioTypeVisibility() {
        const audioInputType = this.container.querySelector('#audioInputType') as HTMLSelectElement;
        const microphoneSection = this.container.querySelector('#microphoneSection') as HTMLElement;

        if (audioInputType && microphoneSection) {
            const isMicrophone = audioInputType.value === 'microphone';
            microphoneSection.style.display = isMicrophone ? 'block' : 'none';
        }
    }

    private updateTranscriptionModeVisibility() {
        const transcriptionMode = this.container.querySelector('#transcriptionMode') as HTMLSelectElement;
        const apiSection = this.container.querySelector('#apiTranscriptionSection') as HTMLElement;
        const localSection = this.container.querySelector('#localTranscriptionSection') as HTMLElement;
        const localDeviceSection = this.container.querySelector('#localDeviceSection') as HTMLElement;

        if (transcriptionMode && apiSection && localSection && localDeviceSection) {
            const isLocal = transcriptionMode.value === 'local';
            apiSection.style.display = isLocal ? 'none' : 'block';
            localSection.style.display = isLocal ? 'block' : 'none';
            localDeviceSection.style.display = isLocal ? 'block' : 'none';
        }
    }

    private async loadAudioDevices() {
        const deviceSelect = this.container.querySelector('#audioInputDevice') as HTMLSelectElement;
        if (!deviceSelect) return;

        try {
            const devices = await window.api.settings.getAudioDevices();
            deviceSelect.innerHTML = '';

            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = 'Default (System Default)';
            deviceSelect.appendChild(defaultOption);

            devices.forEach((device: { deviceId: string; label: string; kind: 'audioinput' | 'audiooutput' }) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                const maxLength = 50;
                const displayLabel = device.label.length > maxLength
                    ? device.label.substring(0, maxLength) + '...'
                    : device.label;
                option.textContent = displayLabel;
                option.title = device.label;
                deviceSelect.appendChild(option);
            });

            if (this.settings.audioInputDeviceId) {
                deviceSelect.value = this.settings.audioInputDeviceId;
            }
        } catch (error) {
            console.error('Error loading audio devices:', error);
            deviceSelect.innerHTML = '<option value="">Error loading devices</option>';
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
        });

        const transcriptionModeSelect = this.container.querySelector('#transcriptionMode') as HTMLSelectElement;
        if (transcriptionModeSelect) {
            transcriptionModeSelect.value = this.settings.transcriptionMode || 'api';

            transcriptionModeSelect.addEventListener('change', async () => {
                const mode = transcriptionModeSelect.value as 'api' | 'local';
                logger.info('settings', 'Transcription mode changed', { mode });
                try {
                    await window.api.settings.setTranscriptionMode(mode);
                    this.settings.transcriptionMode = mode;
                    this.updateTranscriptionModeVisibility();
                    this.showNotification(`Transcription mode changed to ${mode === 'api' ? 'API' : 'Local'}`);
                } catch (error) {
                    this.showNotification('Error saving transcription mode', 'error');
                }
            });
        }

        const transcriptionModelSelect = this.container.querySelector('#transcriptionModel') as HTMLSelectElement;
        if (transcriptionModelSelect) {
            transcriptionModelSelect.value = this.settings.transcriptionModel || 'gpt-4o-mini-transcribe';

            transcriptionModelSelect.addEventListener('change', async () => {
                const model = transcriptionModelSelect.value;
                logger.info('settings', 'Transcription model changed', { model });
                try {
                    await window.api.settings.setTranscriptionModel(model);
                    this.settings.transcriptionModel = model;
                    this.showNotification(`Transcription model changed to ${model}`);
                } catch (error) {
                    this.showNotification('Error saving transcription model', 'error');
                }
            });
        }

        const localWhisperModelSelect = this.container.querySelector('#localWhisperModel') as HTMLSelectElement;
        if (localWhisperModelSelect) {
            localWhisperModelSelect.value = this.settings.localWhisperModel || 'base';

            localWhisperModelSelect.addEventListener('change', async () => {
                const model = localWhisperModelSelect.value as 'tiny' | 'base' | 'small' | 'medium' | 'large' | 'large-v2' | 'large-v3';
                logger.info('settings', 'Local Whisper model changed', { model });
                try {
                    await window.api.settings.setLocalWhisperModel(model);
                    this.settings.localWhisperModel = model;
                    this.showNotification(`Local Whisper model changed to ${model}`);
                } catch (error) {
                    this.showNotification('Error saving local Whisper model', 'error');
                }
            });
        }

        const localDeviceSelect = this.container.querySelector('#localDevice') as HTMLSelectElement;
        if (localDeviceSelect) {
            localDeviceSelect.value = this.settings.localDevice || 'cpu';

            localDeviceSelect.addEventListener('change', async () => {
                const device = localDeviceSelect.value as 'cpu' | 'gpu';
                logger.info('settings', 'Local device changed', { device });
                try {
                    await window.api.settings.setLocalDevice(device);
                    this.settings.localDevice = device;
                    this.showNotification(`Local device changed to ${device.toUpperCase()}`);
                } catch (error) {
                    this.showNotification('Error saving local device', 'error');
                }
            });
        }

        const llmModelSelect = this.container.querySelector('#llmModel') as HTMLSelectElement;
        if (llmModelSelect) {
            llmModelSelect.value = this.settings.llmModel || 'gpt-4.1-nano';

            llmModelSelect.addEventListener('change', async () => {
                const model = llmModelSelect.value;
                logger.info('settings', 'LLM model changed', { model });
                try {
                    await window.api.settings.setLlmModel(model);
                    this.settings.llmModel = model;
                    this.showNotification(`LLM model changed to ${model}`);
                } catch (error) {
                    this.showNotification('Error saving LLM model', 'error');
                }
            });
        }

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

        const audioInputTypeSelect = this.container.querySelector('#audioInputType') as HTMLSelectElement;
        if (audioInputTypeSelect) {
            audioInputTypeSelect.value = this.settings.audioInputType || 'microphone';

            audioInputTypeSelect.addEventListener('change', async () => {
                const audioType = audioInputTypeSelect.value as 'microphone' | 'system';
                logger.info('settings', 'Audio input type changed', { audioType });
                try {
                    await window.api.settings.setAudioInputType(audioType);
                    this.settings.audioInputType = audioType;
                    this.updateAudioTypeVisibility();
                    this.showNotification(`Audio input type changed to ${audioType === 'microphone' ? 'Microphone' : 'System Audio'}`);
                } catch (error) {
                    this.showNotification('Error saving audio input type', 'error');
                }
            });
        }

        const audioInputDeviceSelect = this.container.querySelector('#audioInputDevice') as HTMLSelectElement;
        if (audioInputDeviceSelect) {
            audioInputDeviceSelect.addEventListener('change', async () => {
                const deviceId = audioInputDeviceSelect.value;
                logger.info('settings', 'Audio input device changed', { deviceId });
                try {
                    await window.api.settings.setAudioInputDevice(deviceId);
                    this.settings.audioInputDeviceId = deviceId;
                    this.showNotification('Audio input device saved successfully');
                } catch (error) {
                    this.showNotification('Error saving audio input device', 'error');
                }
            });
        }

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
                    this.showNotification(`Always on top ${alwaysOnTop ? 'enabled' : 'disabled'}`);
                } catch (error) {
                    this.showNotification('Error saving always on top setting', 'error');
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
