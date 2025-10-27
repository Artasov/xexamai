import { useEffect, useMemo, useState } from 'react';
import { useSettingsContext } from '../SettingsView/SettingsView';
import type { LlmHost, ScreenProcessingProvider, TranscriptionMode } from '../../../types';
import { logger } from '../../../utils/logger';
import { emitSettingsChange } from '../../../utils/settingsEvents';
import CustomSelect from '../../common/CustomSelect/CustomSelect';
import { SettingsToast } from '../shared/SettingsToast/SettingsToast';
import './AiSettings.scss';

type MessageTone = 'success' | 'error';
type Message = { text: string; tone: MessageTone } | null;

const TRANSCRIPTION_MODE_OPTIONS: { value: TranscriptionMode; label: string }[] = [
    { value: 'api', label: 'API' },
    { value: 'local', label: 'Local' },
];

const LLM_HOST_OPTIONS: { value: LlmHost; label: string }[] = [
    { value: 'api', label: 'API' },
    { value: 'local', label: 'Local' },
];

const STREAM_MODE_OPTIONS = [
    { value: 'base', label: 'Base mode' },
    { value: 'stream', label: 'Google stream' },
];

const TRANSCRIPTION_MODEL_OPTIONS = [
    { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe (Default)' },
    { value: 'whisper-1', label: 'Whisper-1 (Balanced)' },
    { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe (High Quality)' },
];

const LOCAL_WHISPER_OPTIONS = [
    { value: 'tiny', label: 'Tiny' },
    { value: 'base', label: 'Base' },
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
    { value: 'large-v2', label: 'Large V2' },
    { value: 'large-v3', label: 'Large V3' },
];

const LOCAL_DEVICE_OPTIONS = [
    { value: 'cpu', label: 'CPU' },
    { value: 'gpu', label: 'GPU' },
];

const API_LLM_MODELS = [
    { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano (Default)' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'gpt-4', label: 'GPT-4' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
    { value: 'gpt-3.5-turbo-16k', label: 'GPT-3.5 Turbo 16K' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
];

const LOCAL_LLM_MODELS = [
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

const SCREEN_MODEL_OPTIONS: { value: ScreenProcessingProvider; label: string }[] = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'google', label: 'Google Gemini' },
];

const DEFAULT_API_LLM_MODEL = API_LLM_MODELS[0]?.value ?? 'gpt-4.1-nano';
const DEFAULT_LOCAL_LLM_MODEL =
    LOCAL_LLM_MODELS.find((option) => option.value === 'gpt-oss:20b')?.value ?? LOCAL_LLM_MODELS[0]?.value ?? 'gpt-oss:20b';

export const AiSettings = () => {
    const { settings, patchLocal } = useSettingsContext();
    const [transcriptionPrompt, setTranscriptionPrompt] = useState(settings.transcriptionPrompt ?? '');
    const [llmPrompt, setLlmPrompt] = useState(settings.llmPrompt ?? '');
    const [screenPrompt, setScreenPrompt] = useState(settings.screenProcessingPrompt ?? '');
    const [apiSttTimeout, setApiSttTimeout] = useState(settings.apiSttTimeoutMs ?? 10000);
    const [apiLlmTimeout, setApiLlmTimeout] = useState(settings.apiLlmTimeoutMs ?? 10000);
    const [screenTimeout, setScreenTimeout] = useState(settings.screenProcessingTimeoutMs ?? 50000);
    const [message, setMessage] = useState<Message>(null);

    useEffect(() => {
        setTranscriptionPrompt(settings.transcriptionPrompt ?? '');
        setLlmPrompt(settings.llmPrompt ?? '');
        setScreenPrompt(settings.screenProcessingPrompt ?? '');
        setApiSttTimeout(settings.apiSttTimeoutMs ?? 10000);
        setApiLlmTimeout(settings.apiLlmTimeoutMs ?? 10000);
        setScreenTimeout(settings.screenProcessingTimeoutMs ?? 50000);
    }, [settings]);

    const apiLlmModel = useMemo(
        () => settings.apiLlmModel ?? settings.llmModel ?? DEFAULT_API_LLM_MODEL,
        [settings.apiLlmModel, settings.llmModel],
    );
    const localLlmModel = useMemo(
        () => settings.localLlmModel ?? settings.llmModel ?? DEFAULT_LOCAL_LLM_MODEL,
        [settings.localLlmModel, settings.llmModel],
    );
    const apiHostSelected = settings.llmHost !== 'local';

    const showMessage = (text: string, tone: MessageTone = 'success') => {
        setMessage({ text, tone });
        setTimeout(() => {
            setMessage((prev) => (prev?.text === text ? null : prev));
        }, 3200);
    };

    const requireOpenAi = () => {
        const has = Boolean(settings.openaiApiKey && settings.openaiApiKey.trim().length > 0);
        if (!has) {
            showMessage('Add an OpenAI API key first', 'error');
        }
        return has;
    };

    const requireGoogle = () => {
        const has = Boolean(settings.googleApiKey && settings.googleApiKey.trim().length > 0);
        if (!has) {
            showMessage('Add a Google API key first', 'error');
        }
        return has;
    };

    const handleTranscriptionModeChange = async (mode: TranscriptionMode) => {
        if (mode === 'api' && !requireOpenAi()) {
            return;
        }
        if (mode === 'local' && settings.streamMode === 'stream') {
            showMessage('Disable Google stream before switching to local transcription', 'error');
            return;
        }
        try {
            await window.api.settings.setTranscriptionMode(mode);
            patchLocal({ transcriptionMode: mode });
            showMessage(`Transcription mode switched to ${mode.toUpperCase()}`);
        } catch (error) {
            logger.error('settings', 'Failed to set transcription mode', { error });
            showMessage('Failed to update transcription mode', 'error');
        }
    };

    const handleStreamModeChange = async (mode: 'base' | 'stream') => {
        if (mode === 'stream') {
            if (settings.transcriptionMode === 'local') {
                showMessage('Stream mode requires API transcription', 'error');
                return;
            }
            if (!requireGoogle()) return;
        }
        try {
            await window.api.settings.setStreamMode(mode);
            patchLocal({ streamMode: mode });
            emitSettingsChange('streamMode', mode);
            showMessage(`Stream mode changed to ${mode}`);
        } catch (error) {
            logger.error('settings', 'Failed to set stream mode', { error });
            showMessage('Failed to update stream mode', 'error');
        }
    };

    const handleLlmHostChange = async (host: LlmHost) => {
        if (host === 'api' && !requireOpenAi() && !requireGoogle()) {
            return;
        }
        const targetModel = host === 'local'
            ? (settings.localLlmModel ?? DEFAULT_LOCAL_LLM_MODEL)
            : (settings.apiLlmModel ?? DEFAULT_API_LLM_MODEL);
        try {
            await window.api.settings.setLlmHost(host);
            if (host === 'local') {
                patchLocal({ llmHost: host, llmModel: targetModel, localLlmModel: targetModel });
            } else {
                patchLocal({ llmHost: host, llmModel: targetModel, apiLlmModel: targetModel });
            }
            showMessage(`LLM host set to ${host.toUpperCase()}`);
        } catch (error) {
            logger.error('settings', 'Failed to set LLM host', { error });
            showMessage('Failed to update LLM host', 'error');
        }
    };

    const handleTranscriptionModelChange = async (model: string) => {
        if (!requireOpenAi()) {
            return;
        }
        try {
            await window.api.settings.setTranscriptionModel(model);
            patchLocal({ transcriptionModel: model });
            showMessage(`Transcription model set to ${model}`);
        } catch (error) {
            logger.error('settings', 'Failed to set transcription model', { error });
            showMessage('Failed to update transcription model', 'error');
        }
    };

    const handleLocalWhisperChange = async (model: string) => {
        try {
            await window.api.settings.setLocalWhisperModel(model as any);
            patchLocal({ localWhisperModel: model as any });
            showMessage(`Local Whisper model set to ${model}`);
        } catch (error) {
            logger.error('settings', 'Failed to set local whisper model', { error });
            showMessage('Failed to update local whisper model', 'error');
        }
    };

    const handleLocalDeviceChange = async (device: 'cpu' | 'gpu') => {
        try {
            await window.api.settings.setLocalDevice(device);
            patchLocal({ localDevice: device });
            showMessage(`Local device set to ${device.toUpperCase()}`);
        } catch (error) {
            logger.error('settings', 'Failed to set local device', { error });
            showMessage('Failed to update local device', 'error');
        }
    };

    const handleApiLlmModelChange = async (model: string) => {
        const needsOpenAi = model.startsWith('gpt');
        const needsGoogle = model.startsWith('gemini');
        if (needsOpenAi && !requireOpenAi()) return;
        if (needsGoogle && !requireGoogle()) return;
        try {
            await window.api.settings.setLlmModel(model);
            const isApiHost = settings.llmHost !== 'local';
            patchLocal({
                llmModel: isApiHost ? model : settings.llmModel,
                apiLlmModel: model,
            });
            showMessage(`LLM model set to ${model}`);
        } catch (error) {
            logger.error('settings', 'Failed to set LLM model', { error });
            showMessage('Failed to update LLM model', 'error');
        }
    };

    const handleLocalLlmModelChange = async (model: string) => {
        try {
            await window.api.settings.setLlmModel(model);
            const isLocalHost = settings.llmHost === 'local';
            patchLocal({
                llmModel: isLocalHost ? model : settings.llmModel,
                localLlmModel: model,
            });
            showMessage(`Local LLM model set to ${model}`);
        } catch (error) {
            logger.error('settings', 'Failed to set local LLM model', { error });
            showMessage('Failed to update local LLM model', 'error');
        }
    };

    const handleTranscriptionPromptSave = async () => {
        try {
            await window.api.settings.setTranscriptionPrompt(transcriptionPrompt.trim());
            patchLocal({ transcriptionPrompt: transcriptionPrompt.trim() });
            showMessage('Transcription prompt saved');
        } catch (error) {
            logger.error('settings', 'Failed to save transcription prompt', { error });
            showMessage('Failed to save transcription prompt', 'error');
        }
    };

    const handleLlmPromptSave = async () => {
        try {
            await window.api.settings.setLlmPrompt(llmPrompt.trim());
            patchLocal({ llmPrompt: llmPrompt.trim() });
            showMessage('LLM prompt saved');
        } catch (error) {
            logger.error('settings', 'Failed to save LLM prompt', { error });
            showMessage('Failed to save LLM prompt', 'error');
        }
    };

    const handleScreenPromptSave = async () => {
        try {
            await window.api.settings.setScreenProcessingPrompt(screenPrompt.trim());
            patchLocal({ screenProcessingPrompt: screenPrompt.trim() });
            showMessage('Screen processing prompt saved');
        } catch (error) {
            logger.error('settings', 'Failed to save screen prompt', { error });
            showMessage('Failed to save screen prompt', 'error');
        }
    };

    const handleScreenProviderChange = async (provider: ScreenProcessingProvider) => {
        if (provider === 'openai' && !requireOpenAi()) return;
        if (provider === 'google' && !requireGoogle()) return;
        try {
            await window.api.settings.setScreenProcessingModel(provider);
            patchLocal({ screenProcessingModel: provider });
            showMessage(`Screen processing model set to ${provider}`);
        } catch (error) {
            logger.error('settings', 'Failed to set screen processing model', { error });
            showMessage('Failed to update screen processing model', 'error');
        }
    };

    const saveTimeouts = async () => {
        try {
            await Promise.all([
                window.api.settings.setApiSttTimeoutMs(apiSttTimeout),
                window.api.settings.setApiLlmTimeoutMs(apiLlmTimeout),
                window.api.settings.setScreenProcessingTimeoutMs(screenTimeout),
            ]);
            patchLocal({
                apiSttTimeoutMs: apiSttTimeout,
                apiLlmTimeoutMs: apiLlmTimeout,
                screenProcessingTimeoutMs: screenTimeout,
            });
            showMessage('Timeout values saved');
        } catch (error) {
            logger.error('settings', 'Failed to save timeout values', { error });
            showMessage('Failed to save timeouts', 'error');
        }
    };

    return (
        <div className="ai-settings">
            <SettingsToast message={message} />

            <section className="settings-card card">
                <h3 className="settings-card__title">Modes</h3>
                <div className="ai-settings__grid">
                    <div className="settings-field">
                        <label className="settings-field__label">Transcription</label>
                        <CustomSelect
                            value={settings.transcriptionMode ?? 'api'}
                            options={TRANSCRIPTION_MODE_OPTIONS}
                            onChange={(val) => handleTranscriptionModeChange(val as TranscriptionMode)}
                        />
                    </div>
                    <div className="settings-field">
                        <label className="settings-field__label">LLM</label>
                        <CustomSelect
                            value={settings.llmHost ?? 'api'}
                            options={LLM_HOST_OPTIONS}
                            onChange={(val) => handleLlmHostChange(val as LlmHost)}
                        />
                    </div>
                    <div className="settings-field">
                        <label className="settings-field__label">Stream mode</label>
                        <CustomSelect
                            value={settings.streamMode ?? 'base'}
                            options={STREAM_MODE_OPTIONS}
                            onChange={(val) => handleStreamModeChange(val as 'base' | 'stream')}
                        />
                    </div>
                </div>
            </section>

            <section className="settings-card card">
                <h3 className="settings-card__title">Models</h3>
                <div className="ai-settings__grid">
                    <div className="settings-field">
                        <label className="settings-field__label">API transcription</label>
                        <CustomSelect
                            value={settings.transcriptionModel ?? 'gpt-4o-mini-transcribe'}
                            options={TRANSCRIPTION_MODEL_OPTIONS}
                            disabled={settings.transcriptionMode === 'local'}
                            onChange={handleTranscriptionModelChange}
                        />
                    </div>

                    {settings.transcriptionMode === 'local' ? (
                        <div className="settings-field">
                            <label className="settings-field__label">Local Whisper model</label>
                            <CustomSelect
                                value={settings.localWhisperModel ?? 'base'}
                                options={LOCAL_WHISPER_OPTIONS}
                                onChange={handleLocalWhisperChange}
                            />
                        </div>
                    ) : null}

                    {settings.transcriptionMode === 'local' ? (
                        <div className="settings-field">
                            <label className="settings-field__label">Local device</label>
                            <CustomSelect
                                value={settings.localDevice ?? 'cpu'}
                                options={LOCAL_DEVICE_OPTIONS}
                                onChange={(val) => handleLocalDeviceChange(val as 'cpu' | 'gpu')}
                            />
                        </div>
                    ) : null}

                    {apiHostSelected ? (
                        <div className="settings-field">
                            <label className="settings-field__label">API LLM model</label>
                            <CustomSelect
                                value={apiLlmModel}
                                options={API_LLM_MODELS}
                                onChange={handleApiLlmModelChange}
                            />
                        </div>
                    ) : (
                        <div className="settings-field">
                            <label className="settings-field__label">Local LLM model</label>
                            <CustomSelect
                                value={localLlmModel}
                                options={LOCAL_LLM_MODELS}
                                onChange={handleLocalLlmModelChange}
                            />
                        </div>
                    )}

                    <div className="settings-field">
                        <label className="settings-field__label">Screen processing</label>
                        <CustomSelect
                            value={settings.screenProcessingModel ?? 'openai'}
                            options={SCREEN_MODEL_OPTIONS}
                            onChange={(val) => handleScreenProviderChange(val as ScreenProcessingProvider)}
                        />
                    </div>
                </div>
            </section>

            <section className="settings-card card">
                <h3 className="settings-card__title">Prompts</h3>
                <div className="ai-settings__grid ai-settings__grid--prompts">
                    <div className="settings-field">
                        <label className="settings-field__label">Transcription prompt</label>
                        <textarea
                            className="input-field prompt-textarea"
                            rows={4}
                            value={transcriptionPrompt}
                            onChange={(event) => setTranscriptionPrompt(event.target.value)}
                        />
                        <button type="button" className="btn btn-sm" onClick={handleTranscriptionPromptSave}>
                            Save prompt
                        </button>
                    </div>
                    <div className="settings-field">
                        <label className="settings-field__label">LLM system prompt</label>
                        <textarea
                            className="input-field prompt-textarea"
                            rows={4}
                            value={llmPrompt}
                            onChange={(event) => setLlmPrompt(event.target.value)}
                        />
                        <button type="button" className="btn btn-sm" onClick={handleLlmPromptSave}>
                            Save prompt
                        </button>
                    </div>
                    <div className="settings-field">
                        <label className="settings-field__label">Screen processing prompt</label>
                        <textarea
                            className="input-field prompt-textarea"
                            rows={4}
                            value={screenPrompt}
                            onChange={(event) => setScreenPrompt(event.target.value)}
                        />
                        <button type="button" className="btn btn-sm" onClick={handleScreenPromptSave}>
                            Save prompt
                        </button>
                    </div>
                </div>
            </section>

            <section className="settings-card card">
                <h3 className="settings-card__title">API timeouts (ms)</h3>
                <div className="ai-settings__grid ai-settings__grid--timeouts">
                    <div className="settings-field">
                        <label className="settings-field__label">Transcription</label>
                        <input
                            type="number"
                            className="input-field"
                            min={1000}
                            max={600000}
                            step={500}
                            value={apiSttTimeout}
                            onChange={(event) => setApiSttTimeout(Number(event.target.value))}
                        />
                    </div>
                    <div className="settings-field">
                        <label className="settings-field__label">LLM</label>
                        <input
                            type="number"
                            className="input-field"
                            min={1000}
                            max={600000}
                            step={500}
                            value={apiLlmTimeout}
                            onChange={(event) => setApiLlmTimeout(Number(event.target.value))}
                        />
                    </div>
                    <div className="settings-field">
                        <label className="settings-field__label">Screen processing</label>
                        <input
                            type="number"
                            className="input-field"
                            min={1000}
                            max={600000}
                            step={500}
                            value={screenTimeout}
                            onChange={(event) => setScreenTimeout(Number(event.target.value))}
                        />
                    </div>
                </div>
                <button type="button" className="btn btn-sm" onClick={saveTimeouts}>
                    Save timeouts
                </button>
            </section>
        </div>
    );
};
