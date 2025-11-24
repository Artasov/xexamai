
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, Button, CircularProgress, IconButton, TextField, Typography} from '@mui/material';
import {listen, type UnlistenFn} from '@tauri-apps/api/event';
import {
    API_LLM_MODELS,
    FAST_WHISPER_HEALTH_ENDPOINT,
    GEMINI_LLM_MODELS,
    GOOGLE_TRANSCRIBE_MODELS,
    LOCAL_LLM_MODELS,
    LOCAL_LLM_SIZE_HINTS,
    LOCAL_TRANSCRIBE_MODELS,
    OPENAI_LLM_MODELS,
    OPENAI_TRANSCRIBE_MODELS,
    TRANSCRIBE_API_MODELS,
} from '@shared/constants';
import type {FastWhisperStatus} from '@shared/ipc';
import type {LlmHost, ScreenProcessingProvider, TranscriptionMode} from '../../../types';
import {useSettingsContext} from '../SettingsView/SettingsView';
import {logger} from '../../../utils/logger';
import {emitSettingsChange} from '../../../utils/settingsEvents';
import CustomSelect from '../../common/CustomSelect/CustomSelect';
import {SettingsToast} from '../shared/SettingsToast/SettingsToast';
import {
    checkLocalModelDownloaded,
    downloadLocalSpeechModel,
    getLocalWhisperMetadata,
    normalizeLocalWhisperModel,
    subscribeToLocalModelWarmup,
    warmupLocalSpeechModel,
} from '../../../services/localSpeechModels';
import {
    checkOllamaInstalled,
    downloadOllamaModel,
    listInstalledOllamaModels,
    normalizeOllamaModelName,
    subscribeToOllamaDownloads,
    subscribeToOllamaWarmup,
    warmupOllamaModel,
} from '../../../services/ollama';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import './AiSettings.scss';

type MessageTone = 'success' | 'error';
type Message = { text: string; tone: MessageTone } | null;

type LocalAction = 'install' | 'start' | 'restart' | 'reinstall' | 'stop';

type WithLabel = { value: string; label: string };

const DEFAULT_API_TRANSCRIBE_MODEL = TRANSCRIBE_API_MODELS[0] ?? 'gpt-4o-mini-transcribe';
const DEFAULT_LOCAL_TRANSCRIBE_MODEL = 'base';
const DEFAULT_API_LLM_MODEL = API_LLM_MODELS[0] ?? 'gpt-4.1-nano';
const DEFAULT_LOCAL_LLM_MODEL =
    LOCAL_LLM_MODELS.find((value) => value === 'gpt-oss:20b') ?? LOCAL_LLM_MODELS[0] ?? 'gpt-oss:20b';
const FAST_WHISPER_INSTALL_SIZE_HINT = '~4.3GB';

const OPENAI_TRANSCRIBE_SET = new Set<string>(OPENAI_TRANSCRIBE_MODELS as readonly string[]);
const GOOGLE_TRANSCRIBE_SET = new Set<string>(GOOGLE_TRANSCRIBE_MODELS as readonly string[]);
const OPENAI_LLM_SET = new Set<string>(OPENAI_LLM_MODELS as readonly string[]);
const GEMINI_LLM_SET = new Set<string>(GEMINI_LLM_MODELS as readonly string[]);

const TRANSCRIPTION_MODE_OPTIONS: WithLabel[] = [
    { value: 'api', label: 'API' },
    { value: 'local', label: 'Local' },
];

const LLM_HOST_OPTIONS: WithLabel[] = [
    { value: 'api', label: 'API' },
    { value: 'local', label: 'Local' },
];

const STREAM_MODE_OPTIONS: WithLabel[] = [
    { value: 'base', label: 'Base mode' },
    { value: 'stream', label: 'Google stream' },
];

const SCREEN_MODEL_OPTIONS: WithLabel[] = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'google', label: 'Google Gemini' },
];

const LOCAL_DEVICE_OPTIONS: WithLabel[] = [
    { value: 'cpu', label: 'CPU' },
    { value: 'gpu', label: 'GPU' },
];

const toTitle = (value: string): string =>
    value
        .replace(/[:]/g, ' ')
        .replace(/-/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');

const formatTranscribeLabel = (value: string): string => {
    const metadata = getLocalWhisperMetadata(value);
    if (metadata) {
        return `${metadata.label} (${metadata.size})`;
    }
    if (GOOGLE_TRANSCRIBE_SET.has(value)) {
        return `Google ${toTitle(value)}`;
    }
    if (OPENAI_TRANSCRIBE_SET.has(value)) {
        return `OpenAI ${toTitle(value)}`;
    }
    return toTitle(value);
};

const formatLlmLabel = (value: string): string => {
    if (GEMINI_LLM_SET.has(value)) {
        return `Google ${toTitle(value)}`;
    }
    if (OPENAI_LLM_SET.has(value)) {
        return `OpenAI ${toTitle(value)}`;
    }
    const normalized = normalizeOllamaModelName(value);
    const size = LOCAL_LLM_SIZE_HINTS[normalized];
    return size ? `${toTitle(value)} - ${size}` : toTitle(value);
};
export const AiSettings = () => {
    const { settings, patchLocal } = useSettingsContext();

    const [apiSttTimeout, setApiSttTimeout] = useState(settings.apiSttTimeoutMs ?? 10000);
    const [apiLlmTimeout, setApiLlmTimeout] = useState(settings.apiLlmTimeoutMs ?? 10000);
    const [screenTimeout, setScreenTimeout] = useState(settings.screenProcessingTimeoutMs ?? 50000);
    const [message, setMessage] = useState<Message>(null);

    const [localStatus, setLocalStatus] = useState<FastWhisperStatus | null>(null);
    const [localAction, setLocalAction] = useState<LocalAction | null>(null);
    const [localModelReady, setLocalModelReady] = useState<boolean | null>(null);
    const [checkingLocalModel, setCheckingLocalModel] = useState(false);
    const [downloadingLocalModel, setDownloadingLocalModel] = useState(false);
    const [localModelError, setLocalModelError] = useState<string | null>(null);
    const [localModelWarming, setLocalModelWarming] = useState(false);

    const [ollamaInstalled, setOllamaInstalled] = useState<boolean | null>(null);
    const [ollamaChecking, setOllamaChecking] = useState(false);
    const [, setOllamaModels] = useState<string[]>([]);
    const [ollamaModelDownloaded, setOllamaModelDownloaded] = useState<boolean | null>(null);
    const [ollamaModelChecking, setOllamaModelChecking] = useState(false);
    const [ollamaDownloading, setOllamaDownloading] = useState(false);
    const [ollamaModelError, setOllamaModelError] = useState<string | null>(null);
    const [ollamaModelWarming, setOllamaModelWarming] = useState(false);

    const lastLocalWarmupRef = useRef<string | null>(null);

    useEffect(() => {
        setApiSttTimeout(settings.apiSttTimeoutMs ?? 10000);
        setApiLlmTimeout(settings.apiLlmTimeoutMs ?? 10000);
        setScreenTimeout(settings.screenProcessingTimeoutMs ?? 50000);
    }, [settings.apiLlmTimeoutMs, settings.apiSttTimeoutMs, settings.screenProcessingTimeoutMs]);

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

    const refreshLocalStatus = useCallback(async (checkHealth = true) => {
        if (!window.api?.localSpeech) return;
        try {
            const status = checkHealth
                ? await window.api.localSpeech.checkHealth()
                : await window.api.localSpeech.getStatus();
            setLocalStatus(status);
        } catch (error) {
            logger.error('settings', 'Failed to fetch local speech status', { error });
        }
    }, []);

    useEffect(() => {
        let unlisten: UnlistenFn | null = null;
        let mounted = true;

        void refreshLocalStatus(true);

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

        const handleVisibility = () => {
            if (!document.hidden) {
                void refreshLocalStatus(true);
            }
        };
        window.addEventListener('focus', handleVisibility);
        document.addEventListener('visibilitychange', handleVisibility);

        return () => {
            mounted = false;
            if (unlisten) {
                void unlisten();
            }
            window.removeEventListener('focus', handleVisibility);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [refreshLocalStatus]);

    useEffect(() => {
        if (settings.transcriptionMode !== 'local') {
            setLocalModelReady(null);
            setLocalModelError(null);
            setCheckingLocalModel(false);
            setLocalModelWarming(false);
            lastLocalWarmupRef.current = null;
            return;
        }
        const model = normalizeLocalWhisperModel(settings.localWhisperModel ?? DEFAULT_LOCAL_TRANSCRIBE_MODEL);
        if (!model || !localStatus?.installed || !localStatus.running) {
            setLocalModelReady(null);
            setLocalModelError(null);
            setCheckingLocalModel(false);
            setLocalModelWarming(false);
            lastLocalWarmupRef.current = null;
            return;
        }
        const unsubscribe = subscribeToLocalModelWarmup((models) => {
            setLocalModelWarming(models.has(model));
        });
        return () => {
            unsubscribe();
        };
    }, [settings.transcriptionMode, settings.localWhisperModel, localStatus?.installed, localStatus?.running]);

    useEffect(() => {
        if (settings.transcriptionMode !== 'local') {
            setLocalModelReady(null);
            setLocalModelError(null);
            setCheckingLocalModel(false);
            lastLocalWarmupRef.current = null;
            return;
        }
        const model = normalizeLocalWhisperModel(settings.localWhisperModel ?? DEFAULT_LOCAL_TRANSCRIBE_MODEL);
        if (!model || !localStatus?.installed || !localStatus.running) {
            setLocalModelReady(null);
            setLocalModelError(null);
            setCheckingLocalModel(false);
            lastLocalWarmupRef.current = null;
            return;
        }
        let cancelled = false;
        setCheckingLocalModel(true);
        setLocalModelError(null);
        checkLocalModelDownloaded(model, { force: true })
            .then((downloaded) => {
                if (cancelled) return;
                setLocalModelReady(downloaded);
                if (downloaded && !localModelWarming && lastLocalWarmupRef.current !== model) {
                    lastLocalWarmupRef.current = model;
                    return warmupLocalSpeechModel(model, settings.localDevice).catch((error) => {
                        lastLocalWarmupRef.current = null;
                        setLocalModelError(error instanceof Error ? error.message : 'Failed to warmup model');
                    });
                }
            })
            .catch((error) => {
                if (cancelled) return;
                setLocalModelError(error instanceof Error ? error.message : 'Failed to check model');
                setLocalModelReady(false);
            })
            .finally(() => {
                if (!cancelled) {
                    setCheckingLocalModel(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [
        settings.transcriptionMode,
        settings.localWhisperModel,
        settings.localDevice,
        localStatus?.installed,
        localStatus?.running,
        localModelWarming,
    ]);

    useEffect(() => {
        if (settings.llmHost !== 'local') {
            setOllamaInstalled(null);
            setOllamaModels([]);
            setOllamaModelDownloaded(null);
            setOllamaModelError(null);
            setOllamaModelWarming(false);
            return;
        }

        let cancelled = false;
        setOllamaChecking(true);
        checkOllamaInstalled()
            .then((installed) => {
                if (cancelled) return;
                setOllamaInstalled(installed);
                if (!installed) {
                    setOllamaModels([]);
                    setOllamaModelDownloaded(null);
                } else {
                    void listInstalledOllamaModels({ force: true })
                        .then((models) => {
                            if (!cancelled) {
                                setOllamaModels(models);
                            }
                        })
                        .catch((error) => {
                            logger.error('settings', 'Failed to list Ollama models', { error });
                            if (!cancelled) {
                                setOllamaModelError(error instanceof Error ? error.message : 'Failed to list models');
                            }
                        })
                        .finally(() => {
                            if (!cancelled) {
                                setOllamaModelChecking(false);
                            }
                        });
                }
            })
            .catch((error) => {
                logger.error('settings', 'Failed to detect Ollama', { error });
                if (!cancelled) {
                    setOllamaInstalled(false);
                    setOllamaModelError(error instanceof Error ? error.message : 'Failed to detect Ollama');
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setOllamaChecking(false);
                }
            });

        const unsubscribeDownload = subscribeToOllamaDownloads((models) => {
            const normalized = normalizeOllamaModelName(settings.localLlmModel ?? DEFAULT_LOCAL_LLM_MODEL);
            setOllamaDownloading(models.has(normalized));
        });
        const unsubscribeWarmup = subscribeToOllamaWarmup((models) => {
            const normalized = normalizeOllamaModelName(settings.localLlmModel ?? DEFAULT_LOCAL_LLM_MODEL);
            setOllamaModelWarming(models.has(normalized));
        });

        return () => {
            cancelled = true;
            unsubscribeDownload();
            unsubscribeWarmup();
        };
    }, [settings.llmHost, settings.localLlmModel]);

    useEffect(() => {
        if (settings.llmHost !== 'local') {
            setOllamaModelDownloaded(null);
            return;
        }
        if (!ollamaInstalled) {
            setOllamaModelDownloaded(false);
            return;
        }
        const normalized = normalizeOllamaModelName(settings.localLlmModel ?? DEFAULT_LOCAL_LLM_MODEL);
        if (!normalized) {
            setOllamaModelDownloaded(false);
            return;
        }
        setOllamaModelChecking(true);
        listInstalledOllamaModels()
            .then((models) => {
                setOllamaModels(models);
                setOllamaModelDownloaded(models.includes(normalized));
            })
            .catch((error) => {
                logger.error('settings', 'Failed to verify Ollama model', { error });
                setOllamaModelError(error instanceof Error ? error.message : 'Failed to verify model');
                setOllamaModelDownloaded(false);
            })
            .finally(() => setOllamaModelChecking(false));
    }, [settings.llmHost, settings.localLlmModel, ollamaInstalled]);

    const handleLocalAction = async (action: LocalAction, fn: () => Promise<FastWhisperStatus>) => {
        if (!window.api?.localSpeech) {
            showMessage('Local speech bridge unavailable', 'error');
            return;
        }
        setLocalAction(action);
        try {
            const status = await fn();
            setLocalStatus(status);
            showMessage(`${action[0].toUpperCase()}${action.slice(1)} complete`);
        } catch (error) {
            logger.error('settings', `Local speech action failed (${action})`, { error });
            showMessage(`Failed to ${action}`, 'error');
        } finally {
            setLocalAction(null);
        }
    };

    const handleTranscriptionModeChange = async (mode: TranscriptionMode) => {
        if (mode === 'local' && settings.streamMode === 'stream') {
            showMessage('Disable Google stream before switching to local transcription', 'error');
            return;
        }
        let targetModel = mode === 'local'
            ? (settings.localWhisperModel ?? DEFAULT_LOCAL_TRANSCRIBE_MODEL)
            : (settings.transcriptionModel ?? DEFAULT_API_TRANSCRIBE_MODEL);
        if (mode === 'api') {
            if (!hasOpenAiKey && !hasGoogleKey) {
                showMessage('Add an API key first', 'error');
                return;
            }
            let preferred = apiTranscribeOptions.includes(targetModel) ? targetModel : apiTranscribeOptions[0];
            if (!hasOpenAiKey && hasGoogleKey) {
                preferred = apiTranscribeOptions.find((value) => GOOGLE_TRANSCRIBE_SET.has(value)) || preferred;
            }
            if (!preferred) {
                showMessage('No API models available', 'error');
                return;
            }
            if (GOOGLE_TRANSCRIBE_SET.has(preferred) && !requireGoogle()) return;
            if (OPENAI_TRANSCRIBE_SET.has(preferred) && !requireOpenAi()) return;
            targetModel = preferred;
        }
        try {
            await window.api.settings.setTranscriptionMode(mode);
            if (mode === 'local') {
                patchLocal({ transcriptionMode: mode, localWhisperModel: targetModel as any });
            } else {
                patchLocal({ transcriptionMode: mode, transcriptionModel: targetModel });
            }
            showMessage(`Transcription mode switched to ${mode.toUpperCase()}`);
        } catch (error) {
            logger.error('settings', 'Failed to set transcription mode', { error });
            showMessage('Failed to update transcription mode', 'error');
        }
    };

    const handleTranscriptionModelChange = async (model: string) => {
        if (settings.transcriptionMode === 'api') {
            if (GOOGLE_TRANSCRIBE_SET.has(model) && !requireGoogle()) return;
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
        const normalized = normalizeLocalWhisperModel(model) || DEFAULT_LOCAL_TRANSCRIBE_MODEL;
        try {
            await window.api.settings.setLocalWhisperModel(normalized as any);
            patchLocal({ localWhisperModel: normalized as any });
            showMessage(`Local Whisper model set to ${normalized}`);
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

    const handleVerifyLocalModel = async () => {
        const model = normalizeLocalWhisperModel(settings.localWhisperModel ?? DEFAULT_LOCAL_TRANSCRIBE_MODEL);
        if (!model) {
            setLocalModelError('Select a local model first.');
            return;
        }
        if (!localStatus?.installed || !localStatus.running) {
            setLocalModelError('Start the local speech server first.');
            return;
        }
        setCheckingLocalModel(true);
        setLocalModelError(null);
        try {
            const downloaded = await checkLocalModelDownloaded(model, { force: true });
            setLocalModelReady(downloaded);
        } catch (error) {
            logger.error('settings', 'Failed to check local model', { error });
            setLocalModelError(error instanceof Error ? error.message : 'Failed to check model');
            setLocalModelReady(false);
        } finally {
            setCheckingLocalModel(false);
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
        let targetModel = host === 'local'
            ? (settings.localLlmModel ?? DEFAULT_LOCAL_LLM_MODEL)
            : (settings.apiLlmModel ?? DEFAULT_API_LLM_MODEL);
        if (host === 'api') {
            if (!hasOpenAiKey && !hasGoogleKey) {
                showMessage('Add an API key first', 'error');
                return;
            }
            let preferred = apiLlmOptions.includes(targetModel) ? targetModel : apiLlmOptions[0];
            if (!hasOpenAiKey && hasGoogleKey) {
                preferred = apiLlmOptions.find((value) => GEMINI_LLM_SET.has(value)) || preferred;
            }
            if (!preferred) {
                showMessage('No API LLM models available', 'error');
                return;
            }
            if (GEMINI_LLM_SET.has(preferred) && !requireGoogle()) return;
            if (OPENAI_LLM_SET.has(preferred) && !requireOpenAi()) return;
            targetModel = preferred;
        }
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

    const handleApiLlmModelChange = async (model: string) => {
        const needsOpenAi = OPENAI_LLM_SET.has(model);
        const needsGoogle = GEMINI_LLM_SET.has(model);
        if (needsOpenAi && !requireOpenAi()) return;
        if (needsGoogle && !requireGoogle()) return;
        try {
            await window.api.settings.setLlmModel(model, 'api');
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
            await window.api.settings.setLlmModel(model, 'local');
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

    const handleLocalModelDownload = async () => {
        if (settings.transcriptionMode !== 'local') return;
        const model = normalizeLocalWhisperModel(settings.localWhisperModel ?? DEFAULT_LOCAL_TRANSCRIBE_MODEL);
        if (!model) return;
        if (!localStatus?.installed || !localStatus.running) {
            setLocalModelError('Start the local speech server first.');
            return;
        }
        setLocalModelError(null);
        setDownloadingLocalModel(true);
        try {
            await downloadLocalSpeechModel(model);
            const downloaded = await checkLocalModelDownloaded(model, { force: true });
            setLocalModelReady(downloaded);
            try {
                await warmupLocalSpeechModel(model, settings.localDevice);
            } catch (error) {
                logger.error('settings', 'Warmup failed after download', { error });
                setLocalModelError('Model ready but warmup failed. Try again.');
            }
            showMessage('Local model ready');
        } catch (error: any) {
            const detail = error?.response?.data?.detail;
            setLocalModelError(detail || (error instanceof Error ? error.message : 'Failed to download model'));
        } finally {
            setDownloadingLocalModel(false);
        }
    };

    const handleLocalModelWarmup = async () => {
        const model = normalizeLocalWhisperModel(settings.localWhisperModel ?? DEFAULT_LOCAL_TRANSCRIBE_MODEL);
        if (!model) return;
        setLocalModelError(null);
        try {
            await warmupLocalSpeechModel(model, settings.localDevice);
            lastLocalWarmupRef.current = model;
            showMessage('Warmup started');
        } catch (error) {
            logger.error('settings', 'Warmup failed', { error });
            setLocalModelError(error instanceof Error ? error.message : 'Failed to warmup model');
            lastLocalWarmupRef.current = null;
        }
    };

    const handleOllamaDownload = async () => {
        if (settings.llmHost !== 'local') return;
        const model = settings.localLlmModel ?? DEFAULT_LOCAL_LLM_MODEL;
        setOllamaModelError(null);
        setOllamaDownloading(true);
        try {
            await downloadOllamaModel(model);
            const models = await listInstalledOllamaModels({ force: true });
            setOllamaModels(models);
            setOllamaModelDownloaded(models.includes(normalizeOllamaModelName(model)));
            try {
                await warmupOllamaModel(model);
            } catch (error) {
                logger.error('settings', 'Ollama warmup failed', { error });
                setOllamaModelError('Model ready but warmup failed.');
            }
            showMessage('LLM model ready');
        } catch (error) {
            logger.error('settings', 'Failed to download Ollama model', { error });
            setOllamaModelError(error instanceof Error ? error.message : 'Failed to download model');
        } finally {
            setOllamaDownloading(false);
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
    const hasOpenAiKey = Boolean(settings.openaiApiKey?.trim());
    const hasGoogleKey = Boolean(settings.googleApiKey?.trim());

    const apiTranscribeOptions = useMemo(() => {
        const models: string[] = [...OPENAI_TRANSCRIBE_MODELS];
        if (hasGoogleKey) {
            models.push(...(GOOGLE_TRANSCRIBE_MODELS as unknown as string[]));
        }
        return models;
    }, [hasGoogleKey]);

    const apiLlmOptions = useMemo(() => {
        const models: string[] = [...OPENAI_LLM_MODELS];
        if (hasGoogleKey) {
            models.push(...(GEMINI_LLM_MODELS as unknown as string[]));
        }
        return models;
    }, [hasGoogleKey]);

    const apiTranscribeModel = settings.transcriptionModel ?? DEFAULT_API_TRANSCRIBE_MODEL;
    const localTranscribeModel = settings.localWhisperModel ?? DEFAULT_LOCAL_TRANSCRIBE_MODEL;
    const apiLlmModel = settings.apiLlmModel ?? settings.llmModel ?? DEFAULT_API_LLM_MODEL;
    const localLlmModel = settings.localLlmModel ?? settings.llmModel ?? DEFAULT_LOCAL_LLM_MODEL;

    const transcribeOptions = useMemo(() => {
        if (settings.transcriptionMode === 'local') {
            return LOCAL_TRANSCRIBE_MODELS.map((model) => ({ value: model, label: formatTranscribeLabel(model) }));
        }
        const models: string[] = [...OPENAI_TRANSCRIBE_MODELS];
        if (hasGoogleKey) {
            models.push(...(GOOGLE_TRANSCRIBE_MODELS as unknown as string[]));
        }
        return models.map((model) => ({ value: model, label: formatTranscribeLabel(model) }));
    }, [settings.transcriptionMode, hasGoogleKey]);

    const llmOptions = useMemo(() => {
        if (settings.llmHost === 'local') {
            return LOCAL_LLM_MODELS.map((model) => ({ value: model, label: formatLlmLabel(model) }));
        }
        const models: string[] = [...OPENAI_LLM_MODELS];
        if (hasGoogleKey) {
            models.push(...(GEMINI_LLM_MODELS as unknown as string[]));
        }
        return models.map((model) => ({ value: model, label: formatLlmLabel(model) }));
    }, [settings.llmHost, hasGoogleKey]);

    const requiresOpenAiForTranscribe = settings.transcriptionMode === 'api' && OPENAI_TRANSCRIBE_SET.has(apiTranscribeModel);
    const requiresGoogleForTranscribe = settings.transcriptionMode === 'api' && GOOGLE_TRANSCRIBE_SET.has(apiTranscribeModel);
    const requiresOpenAiForLlm = settings.llmHost === 'api' && OPENAI_LLM_SET.has(apiLlmModel);
    const requiresGoogleForLlm = settings.llmHost === 'api' && GEMINI_LLM_SET.has(apiLlmModel);

    const transcribeUnavailable =
        settings.transcriptionMode === 'local' && (!localStatus?.installed || !localStatus.running);

    const selectedLocalMetadata = getLocalWhisperMetadata(localTranscribeModel);
    const selectedLocalLlmLabel = formatLlmLabel(localLlmModel);
    const localPhase = (localStatus?.phase || '').toLowerCase();
    const localBusyPhase = ['installing', 'starting', 'stopping', 'reinstalling'].includes(localPhase);
    const localPrimaryAction: LocalAction = !localStatus?.installed
        ? 'install'
        : localStatus.running
            ? 'restart'
            : 'start';
    const localPrimaryLabel = !localStatus?.installed
        ? `Install (${FAST_WHISPER_INSTALL_SIZE_HINT})`
        : localStatus.running
            ? 'Restart'
            : 'Start';
    const localPrimaryDisabled = !!localAction || localBusyPhase;
    const localBusyLabel =
        localPhase === 'installing'
            ? 'Installing...'
            : localPhase === 'starting'
                ? 'Starting...'
                : localPhase === 'reinstalling'
                    ? 'Reinstalling...'
                    : 'Processing...';
    const localLogLineRaw =
        (localStatus as any)?.log_line ??
        localStatus?.logLine ??
        '';
    const localLogLine =
        localLogLineRaw && localLogLineRaw.length > 180
            ? `...${localLogLineRaw.slice(-180)}`
            : localLogLineRaw;
    const localMessage =
        localStatus?.running && !localBusyPhase
            ? ''
            : localBusyPhase && localLogLine
                ? localLogLine
                : (localStatus?.phase === 'idle' ? '' : localStatus?.message || 'Checking server status...');

    useEffect(() => {
        if (settings.transcriptionMode !== 'api') return;
        if (!hasOpenAiKey && !hasGoogleKey) return;
        if (!transcribeOptions.length) return;
        if (!transcribeOptions.some((option) => option.value === apiTranscribeModel)) {
            const fallback =
                (!hasOpenAiKey && hasGoogleKey
                    ? transcribeOptions.find((option) => GOOGLE_TRANSCRIBE_SET.has(option.value))
                    : null) || transcribeOptions[0];
            if (fallback) {
                void handleTranscriptionModelChange(fallback.value);
            }
        }
    }, [settings.transcriptionMode, apiTranscribeModel, transcribeOptions, hasOpenAiKey, hasGoogleKey]);

    useEffect(() => {
        if (settings.llmHost !== 'api') return;
        if (!hasOpenAiKey && !hasGoogleKey) return;
        if (!llmOptions.length) return;
        if (!llmOptions.some((option) => option.value === apiLlmModel)) {
            const fallback =
                (!hasOpenAiKey && hasGoogleKey
                    ? llmOptions.find((option) => GEMINI_LLM_SET.has(option.value))
                    : null) || llmOptions[0];
            if (fallback) {
                void handleApiLlmModelChange(fallback.value);
            }
        }
    }, [settings.llmHost, apiLlmModel, llmOptions, hasOpenAiKey, hasGoogleKey]);

    return (
        <div className="ai-settings">
            <SettingsToast message={message} />

            <section className="settings-card card">
                <h3 className="settings-card__title">Modes & Models</h3>
                <div className="ai-settings__grid ai-settings__grid--models">
                    <div className="settings-field">
                        <label className="settings-field__label">Transcription</label>
                        <CustomSelect
                            value={settings.transcriptionMode ?? 'api'}
                            options={TRANSCRIPTION_MODE_OPTIONS}
                            onChange={(val) => handleTranscriptionModeChange(val as TranscriptionMode)}
                        />
                        {settings.transcriptionMode === 'local' ? (
                            <Box className="ai-settings__local-server" mt={1}>
                                {localStatus?.running && !localBusyPhase ? (
                                    <Box
                                        sx={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            borderRadius: 2,
                                            border: '1px solid rgba(16,185,129,0.4)',
                                            backgroundColor: 'rgba(16,185,129,0.08)',
                                            px: 1.5,
                                            py: 1,
                                            gap: 1,
                                        }}
                                    >
                                        <Box sx={{display: 'flex', alignItems: 'center', gap: 1}}>
                                            <CheckCircleIcon fontSize="small" color="success" />
                                            <Typography fontWeight={700} color="success.main">
                                                Running
                                            </Typography>
                                        </Box>
                                        <Box sx={{display: 'flex', alignItems: 'center', gap: 0.5}}>
                                            <IconButton
                                                size="small"
                                                color="success"
                                                disabled={!!localAction}
                                                onClick={() => void handleLocalAction('restart', () => window.api.localSpeech.restart())}
                                            >
                                                {localAction === 'restart' ? (
                                                    <CircularProgress size={16} sx={{color: 'success.main'}} />
                                                ) : (
                                                    <RestartAltIcon fontSize="small" />
                                                )}
                                            </IconButton>
                                            <IconButton
                                                size="small"
                                                disabled={!!localAction}
                                                onClick={() => void handleLocalAction('stop', () => window.api.localSpeech.stop())}
                                                sx={{
                                                    color: localAction ? 'text.disabled' : 'text.primary',
                                                    '&:hover': {color: 'error.main', backgroundColor: 'rgba(239,68,68,0.12)'},
                                                }}
                                            >
                                                {localAction === 'stop' ? (
                                                    <CircularProgress size={16} sx={{color: 'error.main'}} />
                                                ) : (
                                                    <StopCircleIcon fontSize="small" />
                                                )}
                                            </IconButton>
                                        </Box>
                                    </Box>
                                ) : localStatus?.installed && !localBusyPhase ? (
                                    <Box
                                        sx={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            borderRadius: 2,
                                            border: '1px solid rgba(107,114,128,0.3)',
                                            backgroundColor: 'rgba(107,114,128,0.08)',
                                            px: 1.5,
                                            py: 1,
                                            gap: 1,
                                        }}
                                    >
                                        <Box sx={{display: 'flex', alignItems: 'center', gap: 1}}>
                                            <StopCircleIcon fontSize="small" sx={{color: 'text.secondary'}} />
                                            <Typography fontWeight={700} color="text.secondary">
                                                Stopped
                                            </Typography>
                                        </Box>
                                        <Box sx={{display: 'flex', alignItems: 'center', gap: 1}}>
                                            <IconButton
                                                size="small"
                                                color="primary"
                                                disabled={!!localAction}
                                                onClick={() => void handleLocalAction('start', () => window.api.localSpeech.start())}
                                            >
                                                {localAction === 'start' ? (
                                                    <CircularProgress size={16} color="inherit" />
                                                ) : (
                                                    <PlayArrowIcon fontSize="small" />
                                                )}
                                            </IconButton>
                                            <Button
                                                variant="outlined"
                                                size="small"
                                                color="warning"
                                                disabled={!!localAction}
                                                onClick={() => void handleLocalAction('reinstall', () => window.api.localSpeech.reinstall())}
                                            >
                                                Reinstall
                                            </Button>
                                        </Box>
                                    </Box>
                                ) : (
                                    <Button
                                    variant="contained"
                                    size="small"
                                    color={localStatus?.running ? 'success' : 'primary'}
                                    disabled={localPrimaryDisabled}
                                    onClick={() => {
                                        if (localPrimaryDisabled) {
                                            return;
                                        }
                                        const action = localPrimaryAction;
                                        const fn = action === 'install'
                                            ? () => window.api.localSpeech.install()
                                            : action === 'start'
                                                ? () => window.api.localSpeech.start()
                                                : action === 'restart'
                                                    ? () => window.api.localSpeech.restart()
                                                    : () => window.api.localSpeech.reinstall();
                                        void handleLocalAction(action, fn);
                                    }}
                                >
                                    {localAction || localBusyPhase ? <CircularProgress size={16} color="inherit" /> : null}
                                    {localAction || localBusyPhase ? localBusyLabel : localPrimaryLabel}
                                </Button>
                                )}
                                {localMessage ? (
                                    <div className="ai-settings__hint">
                                        {localMessage}
                                    </div>
                                ) : null}
                            </Box>
                        ) : null}
                    </div>

                    <div className="settings-field">
                        <label className="settings-field__label">Transcription model</label>
                        <CustomSelect
                            value={settings.transcriptionMode === 'local' ? localTranscribeModel : apiTranscribeModel}
                            options={transcribeOptions}
                            onChange={(val) => {
                                if (settings.transcriptionMode === 'local') {
                                    void handleLocalWhisperChange(val);
                                } else {
                                    void handleTranscriptionModelChange(val);
                                }
                            }}
                            disabled={settings.transcriptionMode === 'local' && transcribeUnavailable}
                        />
                        {settings.transcriptionMode === 'local' ? (
                            <div className="ai-settings__status-block">
                                {transcribeUnavailable ? (
                                    <Typography variant="body2" color="warning.main">
                                        Install and start the local server to use local transcription.
                                    </Typography>
                                ) : null}
                                {!transcribeUnavailable && checkingLocalModel ? (
                                    <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <CircularProgress size={14} thickness={5} />
                                        Checking model availability...
                                    </Typography>
                                ) : null}
                                {!transcribeUnavailable && localModelWarming ? (
                                    <Typography variant="body2" color="warning.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <CircularProgress size={16} thickness={5} sx={{ color: 'warning.main' }} />
                                        {selectedLocalMetadata
                                            ? `${selectedLocalMetadata.label} is warming up. Recording is temporarily disabled.`
                                            : 'Model is warming up. Recording is temporarily disabled.'}
                                    </Typography>
                                ) : null}
                                {!transcribeUnavailable && !checkingLocalModel && !localModelWarming && localModelReady === true ? (
                                    <Typography variant="body2" color="success.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        {selectedLocalMetadata ? `${selectedLocalMetadata.label} ready` : 'Model ready'}
                                    </Typography>
                                ) : null}
                                {!transcribeUnavailable && !checkingLocalModel && localModelReady === false ? (
                                    <Button
                                        variant="contained"
                                        size="small"
                                        color="primary"
                                        onClick={handleLocalModelDownload}
                                        disabled={downloadingLocalModel}
                                        startIcon={downloadingLocalModel ? <CircularProgress size={14} color="inherit" /> : undefined}
                                        sx={{ mt: 0.5 }}
                                    >
                                        {selectedLocalMetadata ? `Download ${selectedLocalMetadata.label}` : 'Download model'}
                                    </Button>
                                ) : null}
                                {/* Warmup теперь автоматический, ручной кнопки нет */}
                                {localModelError ? (
                                    <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
                                        {localModelError}
                                    </Typography>
                                ) : null}
                            </div>
                        ) : null}
                    </div>

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

                    <div className="settings-field">
                        <label className="settings-field__label">LLM host</label>
                        <CustomSelect
                            value={settings.llmHost ?? 'api'}
                            options={LLM_HOST_OPTIONS}
                            onChange={(val) => handleLlmHostChange(val as LlmHost)}
                        />
                    </div>

                    <div className="settings-field">
                        <label className="settings-field__label">LLM model</label>
                        <CustomSelect
                            value={settings.llmHost === 'local' ? localLlmModel : apiLlmModel}
                            options={llmOptions}
                            onChange={(val) => {
                                if (settings.llmHost === 'local') {
                                    void handleLocalLlmModelChange(val);
                                } else {
                                    void handleApiLlmModelChange(val);
                                }
                            }}
                            disabled={settings.llmHost === 'local' && (ollamaChecking || !ollamaInstalled)}
                        />
                        {settings.llmHost === 'local' ? (
                            <div className="ai-settings__status-block">
                                {ollamaChecking ? (
                                    <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <CircularProgress size={14} thickness={5} />
                                        Checking Ollama...
                                    </Typography>
                                ) : null}
                                {!ollamaChecking && ollamaInstalled === false ? (
                                    <Typography variant="body2" color="warning.main">
                                        Install Ollama CLI to enable local LLMs.
                                    </Typography>
                                ) : null}
                                {ollamaInstalled && (ollamaModelChecking || ollamaModelDownloaded === null) ? (
                                    <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <CircularProgress size={14} thickness={5} />
                                        Checking model availability...
                                    </Typography>
                                ) : null}
                                {ollamaInstalled && !ollamaModelChecking && ollamaModelWarming ? (
                                    <Typography variant="body2" color="warning.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        <CircularProgress size={16} thickness={5} sx={{ color: 'warning.main' }} />
                                        {selectedLocalLlmLabel} is warming up.
                                    </Typography>
                                ) : null}
                                {ollamaInstalled && !ollamaModelChecking && !ollamaModelWarming && ollamaModelDownloaded === true ? (
                                    <Typography variant="body2" color="success.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                        {selectedLocalLlmLabel} ready
                                    </Typography>
                                ) : null}
                                {ollamaInstalled && !ollamaModelChecking && ollamaModelDownloaded === false ? (
                                    <Button
                                        variant="contained"
                                        size="small"
                                        color="primary"
                                        onClick={handleOllamaDownload}
                                        disabled={ollamaDownloading}
                                        startIcon={ollamaDownloading ? <CircularProgress size={14} color="inherit" /> : undefined}
                                        sx={{ mt: 0.5 }}
                                    >
                                        Download {selectedLocalLlmLabel}
                                    </Button>
                                ) : null}
                                {ollamaModelError ? (
                                    <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
                                        {ollamaModelError}
                                    </Typography>
                                ) : null}
                            </div>
                        ) : null}
                    </div>

                    <div className="settings-field">
                        <label className="settings-field__label">Stream mode</label>
                        <CustomSelect
                            value={settings.streamMode ?? 'base'}
                            options={STREAM_MODE_OPTIONS}
                            onChange={(val) => handleStreamModeChange(val as 'base' | 'stream')}
                        />
                    </div>

                    <div className="settings-field">
                        <label className="settings-field__label">Screen processing</label>
                        <CustomSelect
                            value={settings.screenProcessingModel ?? 'openai'}
                            options={SCREEN_MODEL_OPTIONS}
                            onChange={(val) => handleScreenProviderChange(val as ScreenProcessingProvider)}
                        />
                    </div>

                    {(requiresOpenAiForTranscribe || requiresOpenAiForLlm) ? (
                        <Typography variant="body2" color="text.secondary">
                            OpenAI key required for the selected models.
                        </Typography>
                    ) : null}
                    {(requiresGoogleForTranscribe || requiresGoogleForLlm) ? (
                        <Typography variant="body2" color="text.secondary">
                            Google AI key required for the selected models.
                        </Typography>
                    ) : null}
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

            <section className="settings-card card">
                <h3 className="settings-card__title">Local server status</h3>
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
                        <span>Message</span>
                        <strong>{localStatus?.message ?? 'N/A'}</strong>
                    </div>
                </div>
                <p className="ai-settings__hint">
                    Health endpoint: {FAST_WHISPER_HEALTH_ENDPOINT}
                </p>
            </section>
        </div>
    );
};
