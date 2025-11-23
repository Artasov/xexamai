import { useCallback, useEffect, useMemo, useState } from 'react';
import {TextField} from '@mui/material';
import { useSettingsContext } from '../SettingsView/SettingsView';
import type { LlmHost, ScreenProcessingProvider, TranscriptionMode } from '../../../types';
import type { FastWhisperStatus } from '@shared/ipc';
import { logger } from '../../../utils/logger';
import { emitSettingsChange } from '../../../utils/settingsEvents';
import CustomSelect from '../../common/CustomSelect/CustomSelect';
import { SettingsToast } from '../shared/SettingsToast/SettingsToast';
import './AiSettings.scss';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';

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

const OPENAI_TRANSCRIBE_MODELS = [
    { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe (OpenAI)' },
    { value: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe (OpenAI)' },
    { value: 'whisper-1', label: 'Whisper-1 (OpenAI)' },
];

const GEMINI_TRANSCRIBE_MODELS = [
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google)' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Google)' },
];

const TRANSCRIPTION_MODEL_OPTIONS = [...OPENAI_TRANSCRIBE_MODELS, ...GEMINI_TRANSCRIBE_MODELS];

const LOCAL_WHISPER_OPTIONS = [
    { value: 'tiny', label: 'Tiny (≈75MB)' },
    { value: 'base', label: 'Base (≈141MB)' },
    { value: 'small', label: 'Small (≈463MB)' },
    { value: 'medium', label: 'Medium (≈1.4GB)' },
    { value: 'large-v3', label: 'Large v3 (≈3GB)' },
];

const LOCAL_DEVICE_OPTIONS = [
    { value: 'cpu', label: 'CPU' },
    { value: 'gpu', label: 'GPU' },
];

const OPENAI_LLM_MODELS = [
    { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano (OpenAI)' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (OpenAI)' },
    { value: 'gpt-4o', label: 'GPT-4o (OpenAI)' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini (OpenAI)' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo (OpenAI)' },
    { value: 'chatgpt-4o-latest', label: 'ChatGPT 4o Latest (OpenAI)' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (OpenAI)' },
];

const GEMINI_LLM_MODELS = [
    { value: 'gemini-3.0-pro', label: 'Gemini 3.0 Pro (Google)' },
    { value: 'gemini-3.0-flash', label: 'Gemini 3.0 Flash (Google)' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Google)' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google)' },
    { value: 'gemini-2.0-pro', label: 'Gemini 2.0 Pro (Google)' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Google)' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (Google)' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (Google)' },
];

const API_LLM_MODELS = [...OPENAI_LLM_MODELS, ...GEMINI_LLM_MODELS];

const LOCAL_LLM_MODELS = [
    { value: 'gpt-oss:120b', label: 'GPT-OSS 120B (≈90GB)' },
    { value: 'gpt-oss:20b', label: 'GPT-OSS 20B (≈13GB)' },
    { value: 'gemma3:27b', label: 'Gemma 3 27B (≈21GB)' },
    { value: 'gemma3:12b', label: 'Gemma 3 12B (≈9.5GB)' },
    { value: 'gemma3:4b', label: 'Gemma 3 4B (≈2.2GB)' },
    { value: 'gemma3:1b', label: 'Gemma 3 1B (≈815MB)' },
    { value: 'deepseek-r1:8b', label: 'DeepSeek-R1 8B (≈5.5GB)' },
    { value: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B (≈23GB)' },
    { value: 'qwen3:30b', label: 'Qwen3 30B (≈23GB)' },
    { value: 'qwen3:8b', label: 'Qwen3 8B (≈5.2GB)' },
    { value: 'qwen3:4b', label: 'Qwen3 4B (≈2.5GB)' },
];

const SCREEN_MODEL_OPTIONS: { value: ScreenProcessingProvider; label: string }[] = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'google', label: 'Google Gemini' },
];

const DEFAULT_API_LLM_MODEL = API_LLM_MODELS[0]?.value ?? 'gpt-4.1-nano';
const DEFAULT_LOCAL_LLM_MODEL =
    LOCAL_LLM_MODELS.find((option) => option.value === 'gpt-oss:20b')?.value ?? LOCAL_LLM_MODELS[0]?.value ?? 'gpt-oss:20b';
const GEMINI_LLM_SET = new Set(GEMINI_LLM_MODELS.map((entry) => entry.value));
const OPENAI_LLM_SET = new Set(OPENAI_LLM_MODELS.map((entry) => entry.value));
const GEMINI_TRANSCRIBE_SET = new Set(GEMINI_TRANSCRIBE_MODELS.map((entry) => entry.value));
const OPENAI_TRANSCRIBE_SET = new Set(OPENAI_TRANSCRIBE_MODELS.map((entry) => entry.value));
const LOCAL_WHISPER_ALIASES: Record<string, string> = {
    large: 'large-v3',
    'large-v2': 'large-v3',
};
const LOCAL_WHISPER_EXTRA_INFO: Record<string, string> = {
    tiny: '≈75MB',
    base: '≈141MB',
    small: '≈463MB',
    medium: '≈1.42GB',
    'large-v3': '≈3GB',
};

const normalizeLocalWhisperModel = (value?: string | null): string | null => {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    return LOCAL_WHISPER_ALIASES[normalized] ?? normalized;
};

export const AiSettings = () => {
    const { settings, patchLocal } = useSettingsContext();
    const [transcriptionPrompt, setTranscriptionPrompt] = useState(settings.transcriptionPrompt ?? '');
    const [llmPrompt, setLlmPrompt] = useState(settings.llmPrompt ?? '');
    const [screenPrompt, setScreenPrompt] = useState(settings.screenProcessingPrompt ?? '');
    const [apiSttTimeout, setApiSttTimeout] = useState(settings.apiSttTimeoutMs ?? 10000);
    const [apiLlmTimeout, setApiLlmTimeout] = useState(settings.apiLlmTimeoutMs ?? 10000);
    const [screenTimeout, setScreenTimeout] = useState(settings.screenProcessingTimeoutMs ?? 50000);
    const [message, setMessage] = useState<Message>(null);
    const [localStatus, setLocalStatus] = useState<FastWhisperStatus | null>(null);
    const [localBusy, setLocalBusy] = useState<string | null>(null);
    const [checkingLocalModel, setCheckingLocalModel] = useState(false);
    const [localModelAvailable, setLocalModelAvailable] = useState<boolean | null>(null);
    const [ollamaInstalled, setOllamaInstalled] = useState<boolean | null>(null);
    const [ollamaBusy, setOllamaBusy] = useState<string | null>(null);
    const [ollamaModels, setOllamaModels] = useState<string[]>([]);
    const [ollamaModelInput, setOllamaModelInput] = useState('');
    const [ollamaModelsLoaded, setOllamaModelsLoaded] = useState(false);

    useEffect(() => {
        setTranscriptionPrompt(settings.transcriptionPrompt ?? '');
        setLlmPrompt(settings.llmPrompt ?? '');
        setScreenPrompt(settings.screenProcessingPrompt ?? '');
        setApiSttTimeout(settings.apiSttTimeoutMs ?? 10000);
        setApiLlmTimeout(settings.apiLlmTimeoutMs ?? 10000);
        setScreenTimeout(settings.screenProcessingTimeoutMs ?? 50000);
        if (settings.localLlmModel) {
            setOllamaModelInput(settings.localLlmModel);
        }
    }, [settings]);
    
    const refreshLocalStatus = useCallback(async () => {
        if (!window.api?.localSpeech) return;
        try {
            const status = await window.api.localSpeech.getStatus();
            setLocalStatus(status);
        } catch (error) {
            logger.error('settings', 'Failed to fetch local speech status', { error });
        }
    }, []);

    const verifyLocalModel = useCallback(
        async (overrideModel?: string | null) => {
            if (!window.api?.localSpeech) return;
            const model =
                overrideModel ??
                normalizeLocalWhisperModel(settings.localWhisperModel) ??
                'base';
            setCheckingLocalModel(true);
            try {
                const downloaded = await window.api.localSpeech.checkModelDownloaded(model);
                setLocalModelAvailable(downloaded);
            } catch (error) {
                logger.error('settings', 'Failed to check local model', { error });
                setLocalModelAvailable(null);
            } finally {
                setCheckingLocalModel(false);
            }
        },
        [settings.localWhisperModel],
    );

    useEffect(() => {
        if (!window.api?.localSpeech) return;
        let unlisten: UnlistenFn | null = null;
        let mounted = true;

        void refreshLocalStatus();
        (async () => {
            try {
                unlisten = await listen<FastWhisperStatus>('local-speech:status', (event) => {
                    if (!mounted) return;
                    setLocalStatus(event.payload);
                });
            } catch (error) {
                logger.error('settings', 'Failed to subscribe to local speech status', { error });
            }
        })();

        return () => {
            mounted = false;
            if (unlisten) {
                void unlisten();
            }
        };
    }, [refreshLocalStatus]);

    const apiLlmModel = useMemo(
        () => settings.apiLlmModel ?? settings.llmModel ?? DEFAULT_API_LLM_MODEL,
        [settings.apiLlmModel, settings.llmModel],
    );
    const localLlmModel = useMemo(
        () => settings.localLlmModel ?? settings.llmModel ?? DEFAULT_LOCAL_LLM_MODEL,
        [settings.localLlmModel, settings.llmModel],
    );
    const apiHostSelected = settings.llmHost !== 'local';
    const normalizedLocalWhisper = normalizeLocalWhisperModel(settings.localWhisperModel) ?? 'base';
    const localWhisperSize = LOCAL_WHISPER_EXTRA_INFO[normalizedLocalWhisper];
    const localLlmAvailable = useMemo(() => {
        if (settings.llmHost !== 'local') return null;
        const normalized = (localLlmModel || '').trim();
        if (!normalized) return null;
        return ollamaModels.includes(normalized);
    }, [ollamaModels, localLlmModel, settings.llmHost]);

    const showMessage = (text: string, tone: MessageTone = 'success') => {
        setMessage({ text, tone });
        setTimeout(() => {
            setMessage((prev) => (prev?.text === text ? null : prev));
        }, 3200);
    };
    
    const runLocalAction = useCallback(
        async (label: string, action: () => Promise<FastWhisperStatus>) => {
            if (!window.api?.localSpeech) {
                showMessage('Local speech bridge unavailable', 'error');
                return;
            }
            setLocalBusy(label);
            try {
                const status = await action();
                setLocalStatus(status);
                showMessage(`${label} complete`);
            } catch (error) {
                logger.error('settings', `Local speech action failed (${label})`, { error });
                showMessage(`Failed to ${label.toLowerCase()}`, 'error');
            } finally {
                setLocalBusy(null);
            }
        },
        [],
    );
    
    const runOllamaAction = useCallback(
        async (label: string, action: () => Promise<void>) => {
            if (!window.api?.ollama) {
                showMessage('Ollama bridge unavailable', 'error');
                return;
            }
            setOllamaBusy(label);
            try {
                await action();
                showMessage(`${label} complete`);
            } catch (error) {
                logger.error('settings', `Ollama action failed (${label})`, { error });
                showMessage(`Failed to ${label.toLowerCase()}`, 'error');
            } finally {
                setOllamaBusy(null);
            }
        },
        [],
    );

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
        if (settings.transcriptionMode === 'api') {
            if (GEMINI_TRANSCRIBE_SET.has(model) && !requireGoogle()) return;
            if (OPENAI_TRANSCRIBE_SET.has(model) && !requireOpenAi()) return;
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
        const normalized = normalizeLocalWhisperModel(model) ?? 'base';
        try {
            await window.api.settings.setLocalWhisperModel(normalized as any);
            patchLocal({ localWhisperModel: normalized as any });
            showMessage(`Local Whisper model set to ${normalized}`);
            await verifyLocalModel(normalized);
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
            setOllamaModelInput(model);
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

    const handleLocalHealth = async () => {
        await runLocalAction('Check health', () => window.api.localSpeech.checkHealth());
    };

    const handleLocalInstall = async () => {
        await runLocalAction('Install local server', () => window.api.localSpeech.install());
    };

    const handleLocalStart = async () => {
        await runLocalAction('Start local server', () => window.api.localSpeech.start());
    };

    const handleLocalRestart = async () => {
        await runLocalAction('Restart local server', () => window.api.localSpeech.restart());
    };

    const handleLocalReinstall = async () => {
        await runLocalAction('Reinstall local server', () => window.api.localSpeech.reinstall());
    };

    const handleLocalStop = async () => {
        await runLocalAction('Stop local server', () => window.api.localSpeech.stop());
    };

    const handleOllamaCheck = async () => {
        if (!window.api?.ollama) {
            showMessage('Ollama bridge unavailable', 'error');
            return;
        }
        setOllamaBusy('Check CLI');
        try {
            const installed = await window.api.ollama.checkInstalled();
            setOllamaInstalled(installed);
            showMessage(installed ? 'Ollama CLI detected' : 'Ollama CLI is missing', installed ? 'success' : 'error');
        } catch (error) {
            logger.error('settings', 'Failed to check Ollama status', { error });
            showMessage('Failed to check Ollama CLI', 'error');
        } finally {
            setOllamaBusy(null);
        }
    };

    const handleOllamaList = async () => {
        if (!window.api?.ollama) return;
        setOllamaBusy('List models');
        try {
            const models = await window.api.ollama.listModels();
            setOllamaModels(models);
            setOllamaModelsLoaded(true);
            showMessage('Fetched local models');
        } catch (error) {
            logger.error('settings', 'Failed to list Ollama models', { error });
            showMessage('Failed to list models', 'error');
        } finally {
            setOllamaBusy(null);
        }
    };

    const handleOllamaPull = async () => {
        const model = ollamaModelInput.trim();
        if (!model) {
            showMessage('Enter model name first', 'error');
            return;
        }
        await runOllamaAction('Download model', async () => {
            await window.api.ollama.pullModel(model);
            await handleOllamaList();
        });
    };

    const handleOllamaWarmup = async () => {
        const model = ollamaModelInput.trim();
        if (!model) {
            showMessage('Enter model name first', 'error');
            return;
        }
        await runOllamaAction('Warmup model', () => window.api.ollama.warmupModel(model));
    };

    const formatTimestamp = (value?: number | null) => {
        if (!value || Number.isNaN(value)) return '—';
        try {
            return new Date(value).toLocaleString();
        } catch {
            return String(value);
        }
    };
    
    useEffect(() => {
        if (settings.transcriptionMode === 'local') {
            void refreshLocalStatus();
            void verifyLocalModel();
        } else {
            setLocalModelAvailable(null);
        }
    }, [settings.transcriptionMode, refreshLocalStatus, verifyLocalModel]);

    useEffect(() => {
        if (settings.transcriptionMode === 'local') {
            void verifyLocalModel();
        }
    }, [settings.localWhisperModel, settings.transcriptionMode, verifyLocalModel]);

    useEffect(() => {
        if (settings.llmHost === 'local') {
            void handleOllamaCheck();
            void handleOllamaList();
        }
    }, [settings.llmHost]);

    useEffect(() => {
        if (settings.localLlmModel) {
            setOllamaModelInput(settings.localLlmModel);
        }
    }, [settings.localLlmModel]);

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
                <h3 className="settings-card__title">Local Whisper Server</h3>
                <p className="ai-settings__hint">
                    Запускает fast-fast-whisper локально для режима Transcription = Local. Требует Python и Git.
                </p>
                <div className="ai-settings__status-grid">
                    <div className="ai-settings__status-card">
                        <span>Installed</span>
                        <strong>{localStatus?.installed ? 'Yes' : 'No'}</strong>
                    </div>
                    <div className="ai-settings__status-card">
                        <span>Running</span>
                        <strong>{localStatus?.running ? 'Yes' : 'No'}</strong>
                    </div>
                    <div className="ai-settings__status-card">
                        <span>Phase</span>
                        <strong>{localStatus?.phase ?? 'Unknown'}</strong>
                    </div>
                    <div className="ai-settings__status-card">
                        <span>Updated</span>
                        <strong>{formatTimestamp(localStatus?.updatedAt)}</strong>
                    </div>
                </div>
                <p className="ai-settings__hint">{localStatus?.message ?? 'Status unavailable'}</p>
                {localStatus?.error ? (
                    <p className="ai-settings__hint ai-settings__hint--error">{localStatus.error}</p>
                ) : null}
                <div className="ai-settings__actions">
                    <button type="button" className="btn btn-sm" disabled={!!localBusy} onClick={refreshLocalStatus}>
                        Refresh
                    </button>
                    <button type="button" className="btn btn-sm" disabled={!!localBusy} onClick={handleLocalHealth}>
                        Check health
                    </button>
                    <button type="button" className="btn btn-sm" disabled={!!localBusy} onClick={handleLocalInstall}>
                        Install & Start
                    </button>
                    <button type="button" className="btn btn-sm" disabled={!!localBusy} onClick={handleLocalStart}>
                        Start
                    </button>
                    <button type="button" className="btn btn-sm" disabled={!!localBusy} onClick={handleLocalRestart}>
                        Restart
                    </button>
                    <button type="button" className="btn btn-sm" disabled={!!localBusy} onClick={handleLocalReinstall}>
                        Reinstall
                    </button>
                    <button type="button" className="btn btn-sm" disabled={!!localBusy} onClick={handleLocalStop}>
                        Stop
                    </button>
                </div>
            </section>

            <section className="settings-card card">
                <h3 className="settings-card__title">Ollama (Local LLM)</h3>
                <p className="ai-settings__hint">
                    Используется при выборе LLM = Local. Установите Ollama и скачайте нужные модели.
                </p>
                <div className="ai-settings__status-grid">
                    <div className="ai-settings__status-card">
                        <span>CLI</span>
                        <strong>
                            {ollamaInstalled === null ? 'Unknown' : ollamaInstalled ? 'Installed' : 'Not installed'}
                        </strong>
                    </div>
                </div>
                <div className="ai-settings__actions">
                    <button type="button" className="btn btn-sm" disabled={!!ollamaBusy} onClick={handleOllamaCheck}>
                        Check CLI
                    </button>
                    <button type="button" className="btn btn-sm" disabled={!!ollamaBusy} onClick={handleOllamaList}>
                        List models
                    </button>
                </div>
                <div className="ai-settings__inline-input">
                    <TextField
                        label="Model name"
                        size="small"
                        value={ollamaModelInput}
                        onChange={(event) => setOllamaModelInput(event.target.value)}
                    />
                    <button type="button" className="btn btn-sm" disabled={!!ollamaBusy} onClick={handleOllamaPull}>
                        Download
                    </button>
                    <button type="button" className="btn btn-sm" disabled={!!ollamaBusy} onClick={handleOllamaWarmup}>
                        Warmup
                    </button>
                </div>
                {ollamaModels.length ? (
                    <textarea
                        className="ai-settings__models-output"
                        value={ollamaModels.join('\n')}
                        readOnly
                    />
                ) : null}
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
                            {localWhisperSize ? (
                                <p className="ai-settings__hint">Approx size: {localWhisperSize}</p>
                            ) : null}
                            <div className="ai-settings__status-row">
                                <span>
                                    {checkingLocalModel
                                        ? 'Checking…'
                                        : localModelAvailable
                                            ? 'Model downloaded'
                                            : 'Model not found'}
                                </span>
                                <button
                                    type="button"
                                    className="btn btn-xs"
                                    disabled={checkingLocalModel}
                                    onClick={() => verifyLocalModel()}
                                >
                                    Verify
                                </button>
                            </div>
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
                            <div className="ai-settings__status-row">
                                <span>
                                    {localLlmAvailable === null
                                        ? 'Unknown'
                                        : localLlmAvailable
                                            ? 'Model available'
                                            : 'Not downloaded'}
                                </span>
                                <button
                                    type="button"
                                    className="btn btn-xs"
                                    disabled={!!ollamaBusy}
                                    onClick={handleOllamaList}
                                >
                                    Refresh
                                </button>
                            </div>
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
                <h3 className="settings-card__title">API timeouts (ms)</h3>
                <div className="ai-settings__grid ai-settings__grid--timeouts">
                    <div className="settings-field">
                        <label className="settings-field__label">Transcription</label>
                        <TextField
                            type="number"
                            value={apiSttTimeout}
                            size={'small'}
                            onChange={(event) => setApiSttTimeout(Number(event.target.value))}
                            inputProps={{ min: 1000, max: 600000, step: 500 }}
                        />
                    </div>
                    <div className="settings-field">
                        <label className="settings-field__label">LLM</label>
                        <TextField
                            type="number"
                            value={apiLlmTimeout}
                            size={'small'}
                            onChange={(event) => setApiLlmTimeout(Number(event.target.value))}
                            inputProps={{ min: 1000, max: 600000, step: 500 }}
                        />
                    </div>
                    <div className="settings-field">
                        <label className="settings-field__label">Screen processing</label>
                        <TextField
                            type="number"
                            size={'small'}
                            value={screenTimeout}
                            onChange={(event) => setScreenTimeout(Number(event.target.value))}
                            inputProps={{ min: 1000, max: 600000, step: 500 }}
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
