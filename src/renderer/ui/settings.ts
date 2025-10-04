import type {AppSettings} from '../types.js';

export interface SettingsPanelOptions {
    onSettingsChange?: (settings: AppSettings) => void;
    onDurationsChange?: (durations: number[]) => void;
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
                    <h3 class="settings-title">Transcription Model</h3>
                    <div class="input-group">
                        <select id="transcriptionModel" class="input-field">
                            <option value="gpt-4o-mini-transcribe">GPT-4o Mini Transcribe (Default)</option>
                            <option value="whisper-1">Whisper-1 (Balanced)</option>
                            <option value="gpt-4o-transcribe">GPT-4o Transcribe (High Quality)</option>
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
                    <h3 class="settings-title">Config Folder</h3>
                    <button id="openConfigFolder" class="btn btn-secondary">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 0-2-2z"/>
                            <path d="M8 21v-4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4"/>
                        </svg>
                        Open Config Folder
                    </button>
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

        durationsList.innerHTML = this.settings.durations?.map((duration: number) => `
            <div class="duration-item">
                <span class="duration-value">${duration}s</span>
                <button class="btn btn-sm btn-danger remove-duration" data-duration="${duration}">
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
        });

        const transcriptionModelSelect = this.container.querySelector('#transcriptionModel') as HTMLSelectElement;
        if (transcriptionModelSelect) {
            transcriptionModelSelect.value = this.settings.transcriptionModel || 'gpt-4o-mini-transcribe';

            transcriptionModelSelect.addEventListener('change', async () => {
                const model = transcriptionModelSelect.value;
                try {
                    await window.api.settings.setTranscriptionModel(model);
                    this.settings.transcriptionModel = model;
                    this.showNotification(`Transcription model changed to ${model}`);
                } catch (error) {
                    this.showNotification('Error saving transcription model', 'error');
                }
            });
        }

        const llmModelSelect = this.container.querySelector('#llmModel') as HTMLSelectElement;
        if (llmModelSelect) {
            llmModelSelect.value = this.settings.llmModel || 'gpt-4.1-nano';

            llmModelSelect.addEventListener('change', async () => {
                const model = llmModelSelect.value;
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
                try {
                    await window.api.settings.setTranscriptionPrompt(prompt);
                    this.settings.transcriptionPrompt = prompt;
                    this.showNotification('Transcription prompt saved successfully');
                } catch (error) {
                    this.showNotification('Error saving transcription prompt', 'error');
                }
            });
        }

        const audioInputTypeSelect = this.container.querySelector('#audioInputType') as HTMLSelectElement;
        if (audioInputTypeSelect) {
            audioInputTypeSelect.value = this.settings.audioInputType || 'microphone';

            audioInputTypeSelect.addEventListener('change', async () => {
                const audioType = audioInputTypeSelect.value as 'microphone' | 'system';
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
                await this.loadAudioDevices();
                this.showNotification('Audio devices refreshed');
            });
        }

        const openConfigFolderBtn = this.container.querySelector('#openConfigFolder');
        if (openConfigFolderBtn) {
            openConfigFolderBtn.addEventListener('click', async () => {
                try {
                    await window.api.settings.openConfigFolder();
                } catch (error) {
                    this.showNotification('Error opening config folder', 'error');
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
