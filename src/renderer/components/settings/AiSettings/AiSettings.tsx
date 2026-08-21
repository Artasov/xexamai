// noinspection XmlDeprecatedElement

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    MenuItem,
    TextField,
    Typography,
} from '@mui/material';
import {listen} from '@tauri-apps/api/event';
import {
    GEMINI_LLM_MODELS,
    GOOGLE_LIVE_TRANSCRIBE_MODEL,
    GOOGLE_TRANSCRIBE_MODELS,
    LOCAL_LLM_MODELS,
    LOCAL_TRANSCRIBE_MODELS,
    OPENAI_LIVE_TRANSCRIBE_MODEL,
    OPENAI_LLM_MODELS,
    OPENAI_TRANSCRIBE_MODELS,
    WINKY_LLM_MODELS,
    WINKY_TRANSCRIBE_MODELS,
} from '@shared/constants';
import type {FastWhisperStatus} from '@shared/ipc';
import type {LlmHost, TranscriptionMode} from '@renderer/types';
import {useSettingsContext} from '../SettingsView/SettingsView';
import {logger} from '@renderer/utils/logger';
import {toast} from 'react-toastify';
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
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {formatLlmLabel, formatTranscribeLabel} from './formatters';
import {PromptSettingsSection} from './PromptSettingsSection';
import {TimeoutSettingsSection} from './TimeoutSettingsSection';
import {ProviderCredentialsSection} from './ProviderCredentialsSection';
import {AsyncListenerSlot} from '../../../bridge/asyncListenerSlot';
import {emitSettingsChange} from '../../../utils/settingsEvents';
import './AiSettings.scss';

type LocalAction = 'install' | 'start' | 'restart' | 'reinstall' | 'stop';

type WithLabel = { value: string; label: string };

const DEFAULT_API_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_LOCAL_TRANSCRIBE_MODEL = 'base';
const DEFAULT_API_LLM_MODEL = 'gpt-4.1-nano';
const DEFAULT_LOCAL_LLM_MODEL =
    LOCAL_LLM_MODELS.find((value) => value === 'gpt-oss:20b') ?? LOCAL_LLM_MODELS[0] ?? 'gpt-oss:20b';
const FAST_WHISPER_INSTALL_SIZE_HINT = '~4.3GB';
const WARMUP_VISIBILITY_DELAY_MS = 1200;
const clampTimeout = (value: number) => Number.isFinite(value)
    ? Math.max(1_000, Math.min(600_000, Math.round(value)))
    : 150_000;

const OPENAI_TRANSCRIBE_SET = new Set<string>(OPENAI_TRANSCRIBE_MODELS as readonly string[]);
const GOOGLE_TRANSCRIBE_SET = new Set<string>(GOOGLE_TRANSCRIBE_MODELS as readonly string[]);
const WINKY_TRANSCRIBE_SET = new Set<string>(WINKY_TRANSCRIBE_MODELS as readonly string[]);
const OPENAI_LLM_SET = new Set<string>(OPENAI_LLM_MODELS as readonly string[]);
const GEMINI_LLM_SET = new Set<string>(GEMINI_LLM_MODELS as readonly string[]);
const WINKY_LLM_SET = new Set<string>(WINKY_LLM_MODELS as readonly string[]);
const API_TRANSCRIBE_OPTIONS = [
    OPENAI_LIVE_TRANSCRIBE_MODEL,
    GOOGLE_LIVE_TRANSCRIBE_MODEL,
    ...(WINKY_TRANSCRIBE_MODELS as readonly string[]),
    ...(OPENAI_TRANSCRIBE_MODELS as readonly string[]).filter((model) => model !== OPENAI_LIVE_TRANSCRIBE_MODEL),
    ...(GOOGLE_TRANSCRIBE_MODELS as readonly string[]).filter((model) => model !== GOOGLE_LIVE_TRANSCRIBE_MODEL),
];

const TRANSCRIPTION_MODE_OPTIONS: WithLabel[] = [
    {value: 'api', label: 'API'},
    {value: 'local', label: 'Local'},
];

const LLM_HOST_OPTIONS: WithLabel[] = [
    {value: 'api', label: 'API'},
    {value: 'local', label: 'Local'},
];

export const AiSettings = () => {
    const {settings, patchLocal} = useSettingsContext();

    // Provider secrets are write-only in the renderer. Persisted values stay in
    // the OS credential store; only the boolean status flags come back via IPC.
    const [openaiKey, setOpenaiKey] = useState('');
    const [googleKey, setGoogleKey] = useState('');
    const [apiSttTimeout, setApiSttTimeout] = useState(settings.apiSttTimeoutMs ?? 150000);
    const [apiLlmTimeout, setApiLlmTimeout] = useState(settings.apiLlmTimeoutMs ?? 150000);
    const [transcriptionPrompt, setTranscriptionPrompt] = useState(settings.transcriptionPrompt ?? '');
    const [llmPrompt, setLlmPrompt] = useState(settings.llmPrompt ?? '');
    const timeoutSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const promptSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestTimeoutsRef = useRef({apiSttTimeout, apiLlmTimeout});
    const latestPromptsRef = useRef({transcriptionPrompt, llmPrompt});
    const [providerTesting, setProviderTesting] = useState<'openai' | 'google' | null>(null);
    const [providerTestMessage, setProviderTestMessage] = useState<Record<'openai' | 'google', string>>({
        openai: '',
        google: '',
    });

    const [localStatus, setLocalStatus] = useState<FastWhisperStatus | null>(null);
    const [localAction, setLocalAction] = useState<LocalAction | null>(null);
    const [localModelReady, setLocalModelReady] = useState<boolean | null>(null);
    const [checkingLocalModel, setCheckingLocalModel] = useState(false);
    const [downloadingLocalModel, setDownloadingLocalModel] = useState(false);
    const [localModelError, setLocalModelError] = useState<string | null>(null);
    const [localModelWarming, setLocalModelWarming] = useState(false);
    const [localWarmupHydrated, setLocalWarmupHydrated] = useState(settings.transcriptionMode !== 'local');
    const localWarmupDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const localWarmupPendingRef = useRef(false);
    const [infoDialog, setInfoDialog] = useState<'transcribe' | 'llm' | null>(null);

    const [ollamaInstalled, setOllamaInstalled] = useState<boolean | null>(null);
    const [ollamaChecking, setOllamaChecking] = useState(false);
    const [, setOllamaModels] = useState<string[]>([]);
    const [ollamaModelDownloaded, setOllamaModelDownloaded] = useState<boolean | null>(null);
    const [ollamaModelChecking, setOllamaModelChecking] = useState(false);
    const [ollamaDownloading, setOllamaDownloading] = useState(false);
    const [ollamaModelError, setOllamaModelError] = useState<string | null>(null);
    const [ollamaModelWarming, setOllamaModelWarming] = useState(false);

    const lastLocalWarmupRef = useRef<string | null>(null);
    const localStatusDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const showApiKeys = !(settings.transcriptionMode === 'local' && settings.llmHost === 'local');
    const hasOpenAiKey = settings.hasOpenaiApiKey === true;
    const hasGoogleKey = settings.hasGoogleApiKey === true;
    latestTimeoutsRef.current = {apiSttTimeout, apiLlmTimeout};
    latestPromptsRef.current = {transcriptionPrompt, llmPrompt};

    useEffect(() => () => {
        if (timeoutSaveRef.current) clearTimeout(timeoutSaveRef.current);
        if (promptSaveRef.current) clearTimeout(promptSaveRef.current);
        const timeouts = latestTimeoutsRef.current;
        const prompts = latestPromptsRef.current;
        void Promise.all([
            window.api.settings.setApiSttTimeoutMs(clampTimeout(timeouts.apiSttTimeout)),
            window.api.settings.setApiLlmTimeoutMs(clampTimeout(timeouts.apiLlmTimeout)),
            window.api.settings.setTranscriptionPrompt(prompts.transcriptionPrompt || ''),
            window.api.settings.setLlmPrompt(prompts.llmPrompt || ''),
        ]).catch((error) => logger.error('settings', 'Failed to flush pending settings', {error}));
    }, []);

    useEffect(() => {
        setApiSttTimeout(settings.apiSttTimeoutMs ?? 150000);
        setApiLlmTimeout(settings.apiLlmTimeoutMs ?? 150000);
        setTranscriptionPrompt(settings.transcriptionPrompt ?? '');
        setLlmPrompt(settings.llmPrompt ?? '');
    }, [settings.apiLlmTimeoutMs, settings.apiSttTimeoutMs, settings.transcriptionPrompt, settings.llmPrompt]);

    const showMessage = (text: string, tone: 'success' | 'error' = 'success') => {
        if (tone === 'success') return;
        toast[tone](text);
    };

    const saveOpenAi = useCallback(async (value: string) => {
        const key = value.trim();
        try {
            await window.api.settings.setOpenaiApiKey(key);
            patchLocal({hasOpenaiApiKey: Boolean(key)});
            setOpenaiKey('');
            setProviderTestMessage((current) => ({
                ...current,
                openai: key ? 'Saved securely. Test the selected model to verify access.' : 'Stored key removed.',
            }));
            logger.info('settings', 'OpenAI API key saved');
        } catch (error) {
            logger.error('settings', 'Failed to save OpenAI API key', {error});
            showMessage('Failed to save OpenAI key', 'error');
        }
    }, [patchLocal]);

    const saveGoogle = useCallback(async (value: string) => {
        const key = value.trim();
        try {
            await window.api.settings.setGoogleApiKey(key);
            patchLocal({hasGoogleApiKey: Boolean(key)});
            setGoogleKey('');
            setProviderTestMessage((current) => ({
                ...current,
                google: key ? 'Saved securely. Test the selected model to verify access.' : 'Stored key removed.',
            }));
            logger.info('settings', 'Google API key saved');
        } catch (error) {
            logger.error('settings', 'Failed to save Google API key', {error});
            showMessage('Failed to save Google key', 'error');
        }
    }, [patchLocal]);

    const refreshLocalStatus = useCallback(async (checkHealth = true) => {
        if (!window.api?.localSpeech) return;
        try {
            const status = checkHealth
                ? await window.api.localSpeech.checkHealth()
                : await window.api.localSpeech.getStatus();
            setLocalStatus(status);
        } catch (error) {
            logger.error('settings', 'Failed to fetch local speech status', {error});
        }
    }, []);

    useEffect(() => {
        const statusListener = new AsyncListenerSlot<FastWhisperStatus>();
        let mounted = true;

        void refreshLocalStatus(true);

        statusListener.replace(
            (emit) => listen<FastWhisperStatus>('local-speech:status', (event) => emit(event.payload)),
            (next) => {
                if (!mounted) return;
                // Debounce rapid status updates to avoid flickering UI.
                if (localStatusDebounceRef.current) {
                    clearTimeout(localStatusDebounceRef.current);
                    localStatusDebounceRef.current = null;
                }
                localStatusDebounceRef.current = setTimeout(() => {
                    if (!mounted) return;
                    setLocalStatus(next);
                }, 150);
            }
        );

        const handleVisibility = () => {
            if (!document.hidden) {
                void refreshLocalStatus(true);
            }
        };
        window.addEventListener('focus', handleVisibility);
        document.addEventListener('visibilitychange', handleVisibility);

        return () => {
            mounted = false;
            if (localStatusDebounceRef.current) {
                clearTimeout(localStatusDebounceRef.current);
                localStatusDebounceRef.current = null;
            }
            statusListener.clear();
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
            setLocalWarmupHydrated(true);
            lastLocalWarmupRef.current = null;
            return;
        }
        const model = normalizeLocalWhisperModel(settings.localWhisperModel ?? DEFAULT_LOCAL_TRANSCRIBE_MODEL);
        if (!model || !localStatus?.installed || !localStatus.running) {
            setLocalModelReady(null);
            setLocalModelError(null);
            setCheckingLocalModel(false);
            setLocalModelWarming(false);
            setLocalWarmupHydrated(false);
            lastLocalWarmupRef.current = null;
            return;
        }
        setLocalModelWarming(false);
        setLocalWarmupHydrated(false);
        localWarmupPendingRef.current = false;
        const unsubscribe = subscribeToLocalModelWarmup((models) => {
            const target = models.has(model);
            if (localWarmupDebounceRef.current) {
                clearTimeout(localWarmupDebounceRef.current);
                localWarmupDebounceRef.current = null;
            }

            if (target) {
                localWarmupPendingRef.current = true;
                localWarmupDebounceRef.current = setTimeout(() => {
                    if (localWarmupPendingRef.current) {
                        setLocalModelWarming(true);
                        setLocalWarmupHydrated(true);
                    }
                    localWarmupDebounceRef.current = null;
                }, WARMUP_VISIBILITY_DELAY_MS);
            } else {
                localWarmupPendingRef.current = false;
                setLocalModelWarming(false);
                setLocalWarmupHydrated(true);
            }
        });
        return () => {
            if (localWarmupDebounceRef.current) {
                clearTimeout(localWarmupDebounceRef.current);
                localWarmupDebounceRef.current = null;
            }
            localWarmupPendingRef.current = false;
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
        checkLocalModelDownloaded(model, {force: true})
            .then((downloaded) => {
                if (cancelled) return;
                setLocalModelReady(downloaded);
                if (downloaded && !localModelWarming && lastLocalWarmupRef.current !== model) {
                    lastLocalWarmupRef.current = model;
                    return warmupLocalSpeechModel(model).catch((error) => {
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
            setOllamaChecking(false);
            setOllamaModelChecking(false);
            setOllamaDownloading(false);
            return;
        }

        let cancelled = false;

        const refreshOllamaState = async (forceModels = false) => {
            setOllamaModelError(null);
            setOllamaChecking(true);
            setOllamaModelChecking(true);
            try {
                const installed = await checkOllamaInstalled();
                if (cancelled) return;
                setOllamaInstalled(installed);
                if (!installed) {
                    setOllamaModels([]);
                    setOllamaModelDownloaded(false);
                    return;
                }
                const models = await listInstalledOllamaModels({force: forceModels});
                if (cancelled) return;
                setOllamaModels(models);
                const normalized = normalizeOllamaModelName(settings.localLlmModel ?? DEFAULT_LOCAL_LLM_MODEL);
                setOllamaModelDownloaded(normalized ? models.includes(normalized) : false);
            } catch (error) {
                if (cancelled) return;
                logger.error('settings', 'Failed to refresh Ollama status', {error});
                setOllamaModelError(error instanceof Error ? error.message : 'Failed to refresh Ollama status');
                setOllamaModelDownloaded(false);
            } finally {
                if (!cancelled) {
                    setOllamaChecking(false);
                    setOllamaModelChecking(false);
                }
            }
        };

        void refreshOllamaState(true);

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

    const handleLocalAction = async (action: LocalAction, fn: () => Promise<FastWhisperStatus>) => {
        if (!window.api?.localSpeech) {
            showMessage('Local speech bridge unavailable', 'error');
            return;
        }
        setLocalAction(action);
        try {
            const status = await fn();
            setLocalStatus(status);
        } catch (error) {
            logger.error('settings', `Local speech action failed (${action})`, {error});
            showMessage(`Failed to ${action}`, 'error');
        } finally {
            setLocalAction(null);
        }
    };

    const handleTranscriptionModeChange = async (mode: TranscriptionMode) => {
        let targetModel = mode === 'local'
            ? (settings.localWhisperModel ?? DEFAULT_LOCAL_TRANSCRIBE_MODEL)
            : (settings.transcriptionModel ?? DEFAULT_API_TRANSCRIBE_MODEL);
        if (mode === 'api' && !isTranscribeAllowed(targetModel)) {
            const fallback = apiTranscribeOptions.find((value) => isTranscribeAllowed(value));
            if (!fallback) {
                showMessage('No API models available', 'error');
                return;
            }
            targetModel = fallback;
        }
        try {
            await window.api.settings.setTranscriptionMode(mode);
            if (mode === 'local') {
                patchLocal({transcriptionMode: mode, localWhisperModel: targetModel as any});
            } else {
                patchLocal({transcriptionMode: mode, transcriptionModel: targetModel});
            }
            emitSettingsChange('transcriptionMode', mode);
        } catch (error) {
            logger.error('settings', 'Failed to set transcription mode', {error});
            showMessage('Failed to update transcription mode', 'error');
        }
    };

    const handleTranscriptionModelChange = async (model: string) => {
        if (settings.transcriptionMode === 'api' && !isTranscribeAllowed(model)) {
            showMessage('Model is unavailable without the required API key', 'error');
            return;
        }
        if (settings.transcriptionMode === 'api') {
            if (GOOGLE_TRANSCRIBE_SET.has(model) && !hasGoogleKey) {
                showMessage('Google API key is missing, requests may fail', 'error');
            }
            if (OPENAI_TRANSCRIBE_SET.has(model) && !hasOpenAiKey) {
                showMessage('OpenAI API key is missing, requests may fail', 'error');
            }
            if (WINKY_TRANSCRIBE_SET.has(model)) {
                // Winky transcription uses app auth token and backend credits, API keys are not required.
            }
        }
        try {
            await window.api.settings.setTranscriptionModel(model);
            patchLocal({transcriptionModel: model});
            emitSettingsChange('transcriptionModel', model);
        } catch (error) {
            logger.error('settings', 'Failed to set transcription model', {error});
            showMessage('Failed to update transcription model', 'error');
        }
    };

    const handleLocalWhisperChange = async (model: string) => {
        const normalized = normalizeLocalWhisperModel(model) || DEFAULT_LOCAL_TRANSCRIBE_MODEL;
        try {
            await window.api.settings.setLocalWhisperModel(normalized as any);
            patchLocal({localWhisperModel: normalized as any});
        } catch (error) {
            logger.error('settings', 'Failed to set local whisper model', {error});
            showMessage('Failed to update local whisper model', 'error');
        }
    };

    const handleLlmHostChange = async (host: LlmHost) => {
        let targetModel = host === 'local'
            ? (settings.localLlmModel ?? DEFAULT_LOCAL_LLM_MODEL)
            : (settings.apiLlmModel ?? DEFAULT_API_LLM_MODEL);
        if (host === 'api' && !isLlmAllowed(targetModel)) {
            const fallback = apiLlmOptions.find((value) => isLlmAllowed(value));
            if (!fallback) {
                showMessage('No API LLM models available', 'error');
                return;
            }
            targetModel = fallback;
        }
        try {
            await window.api.settings.setLlmHost(host);
            if (host === 'local') {
                patchLocal({llmHost: host, llmModel: targetModel, localLlmModel: targetModel});
            } else {
                patchLocal({llmHost: host, llmModel: targetModel, apiLlmModel: targetModel});
            }
        } catch (error) {
            logger.error('settings', 'Failed to set LLM host', {error});
            showMessage('Failed to update LLM host', 'error');
        }
    };

    const handleApiLlmModelChange = async (model: string) => {
        if (settings.llmHost === 'api' && !isLlmAllowed(model)) {
            showMessage('Model is unavailable without the required API key', 'error');
            return;
        }
        const needsOpenAi = OPENAI_LLM_SET.has(model);
        const needsGoogle = GEMINI_LLM_SET.has(model);
        const isWinkyModel = WINKY_LLM_SET.has(model);
        if (needsOpenAi && !hasOpenAiKey) {
            showMessage('OpenAI API key is missing, requests may fail', 'error');
        }
        if (needsGoogle && !hasGoogleKey) {
            showMessage('Google API key is missing, requests may fail', 'error');
        }
        if (isWinkyModel) {
            // Winky LLM models use app auth token and backend credits, API keys are not required.
        }
        try {
            await window.api.settings.setLlmModel(model, 'api');
            const isApiHost = settings.llmHost !== 'local';
            patchLocal({
                llmModel: isApiHost ? model : settings.llmModel,
                apiLlmModel: model,
            });
        } catch (error) {
            logger.error('settings', 'Failed to set LLM model', {error});
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
        } catch (error) {
            logger.error('settings', 'Failed to set local LLM model', {error});
            showMessage('Failed to update local LLM model', 'error');
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
            const downloaded = await checkLocalModelDownloaded(model, {force: true});
            setLocalModelReady(downloaded);
            try {
                await warmupLocalSpeechModel(model);
            } catch (error) {
                logger.error('settings', 'Warmup failed after download', {error});
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

    const handleOllamaDownload = async () => {
        if (settings.llmHost !== 'local') return;
        const model = settings.localLlmModel ?? DEFAULT_LOCAL_LLM_MODEL;
        setOllamaModelError(null);
        setOllamaDownloading(true);
        try {
            await downloadOllamaModel(model);
            const models = await listInstalledOllamaModels({force: true});
            setOllamaModels(models);
            setOllamaModelDownloaded(models.includes(normalizeOllamaModelName(model)));
            try {
                await warmupOllamaModel(model);
            } catch (error) {
                logger.error('settings', 'Ollama warmup failed', {error});
                setOllamaModelError('Model ready but warmup failed.');
            }
            showMessage('LLM model ready');
        } catch (error) {
            logger.error('settings', 'Failed to download Ollama model', {error});
            setOllamaModelError(error instanceof Error ? error.message : 'Failed to download model');
        } finally {
            setOllamaDownloading(false);
        }
    };

    useEffect(() => {
        if (
            settings.apiSttTimeoutMs === apiSttTimeout &&
            settings.apiLlmTimeoutMs === apiLlmTimeout
        ) {
            return;
        }
        if (timeoutSaveRef.current) {
            clearTimeout(timeoutSaveRef.current);
            timeoutSaveRef.current = null;
        }
        timeoutSaveRef.current = setTimeout(() => {
            void (async () => {
                try {
                    await Promise.all([
                        window.api.settings.setApiSttTimeoutMs(clampTimeout(apiSttTimeout)),
                        window.api.settings.setApiLlmTimeoutMs(clampTimeout(apiLlmTimeout)),
                    ]);
                    patchLocal({
                        apiSttTimeoutMs: clampTimeout(apiSttTimeout),
                        apiLlmTimeoutMs: clampTimeout(apiLlmTimeout),
                    });
                } catch (error) {
                    logger.error('settings', 'Failed to save timeout values', {error});
                    showMessage('Failed to save timeouts', 'error');
                }
            })();
        }, 500);
        return () => {
            if (timeoutSaveRef.current) {
                clearTimeout(timeoutSaveRef.current);
                timeoutSaveRef.current = null;
            }
        };
    }, [
        apiSttTimeout,
        apiLlmTimeout,
        settings.apiSttTimeoutMs,
        settings.apiLlmTimeoutMs,
        patchLocal,
    ]);
    useEffect(() => {
        if (
            transcriptionPrompt === (settings.transcriptionPrompt ?? '') &&
            llmPrompt === (settings.llmPrompt ?? '')
        ) {
            return;
        }
        if (promptSaveRef.current) {
            clearTimeout(promptSaveRef.current);
            promptSaveRef.current = null;
        }
        promptSaveRef.current = setTimeout(() => {
            void (async () => {
                try {
                    await Promise.all([
                        window.api.settings.setTranscriptionPrompt(transcriptionPrompt ?? ''),
                        window.api.settings.setLlmPrompt(llmPrompt ?? ''),
                    ]);
                    patchLocal({
                        transcriptionPrompt: transcriptionPrompt ?? '',
                        llmPrompt: llmPrompt ?? '',
                    });
                } catch (error) {
                    logger.error('settings', 'Failed to save prompts', {error});
                    showMessage('Failed to save prompts', 'error');
                }
            })();
        }, 500);
        return () => {
            if (promptSaveRef.current) {
                clearTimeout(promptSaveRef.current);
                promptSaveRef.current = null;
            }
        };
    }, [transcriptionPrompt, llmPrompt, patchLocal, settings.llmPrompt, settings.transcriptionPrompt]);
    const isTranscribeAllowed = useCallback((model: string) => {
        if (OPENAI_TRANSCRIBE_SET.has(model)) return hasOpenAiKey;
        if (GOOGLE_TRANSCRIBE_SET.has(model)) return hasGoogleKey;
        return true;
    }, [hasGoogleKey, hasOpenAiKey]);

    const isLlmAllowed = useCallback((model: string) => {
        if (OPENAI_LLM_SET.has(model)) return hasOpenAiKey;
        if (GEMINI_LLM_SET.has(model)) return hasGoogleKey;
        return true;
    }, [hasGoogleKey, hasOpenAiKey]);

    const apiTranscribeOptions = useMemo(() => {
        return [...API_TRANSCRIBE_OPTIONS];
    }, []);

    const apiLlmOptions = useMemo(() => {
        const models: string[] = [
            ...(WINKY_LLM_MODELS as unknown as string[]),
            ...OPENAI_LLM_MODELS,
            ...(GEMINI_LLM_MODELS as unknown as string[]),
        ];
        return models;
    }, []);

    const apiTranscribeModel = settings.transcriptionModel ?? DEFAULT_API_TRANSCRIBE_MODEL;
    const localTranscribeModel = settings.localWhisperModel ?? DEFAULT_LOCAL_TRANSCRIBE_MODEL;
    const apiLlmModel = settings.apiLlmModel ?? settings.llmModel ?? DEFAULT_API_LLM_MODEL;
    const localLlmModel = settings.localLlmModel ?? settings.llmModel ?? DEFAULT_LOCAL_LLM_MODEL;

    const testProvider = useCallback(async (provider: 'openai' | 'google') => {
        const configured = provider === 'openai' ? hasOpenAiKey : hasGoogleKey;
        if (!configured) {
            setProviderTestMessage((current) => ({...current, [provider]: 'Save an API key first.'}));
            return;
        }
        const model = provider === 'openai'
            ? (OPENAI_LLM_SET.has(apiLlmModel) ? apiLlmModel : DEFAULT_API_LLM_MODEL)
            : (GEMINI_LLM_SET.has(apiLlmModel) ? apiLlmModel : 'gemini-3.7-flash');
        setProviderTesting(provider);
        setProviderTestMessage((current) => ({...current, [provider]: `Checking ${model}…`}));
        try {
            const result = await window.api.providers.testModel(provider, model);
            setProviderTestMessage((current) => ({...current, [provider]: result.message}));
        } catch (error) {
            setProviderTestMessage((current) => ({
                ...current,
                [provider]: error instanceof Error ? error.message : String(error),
            }));
        } finally {
            setProviderTesting(null);
        }
    }, [apiLlmModel, hasGoogleKey, hasOpenAiKey]);

    const transcribeOptions = useMemo(() => {
        if (settings.transcriptionMode === 'local') {
            return LOCAL_TRANSCRIBE_MODELS.map((model) => ({value: model, label: formatTranscribeLabel(model)}));
        }
        return API_TRANSCRIBE_OPTIONS.map((model) => {
            const allowed = isTranscribeAllowed(model);
            return {
                value: model,
                label: formatTranscribeLabel(model),
                disabled: !allowed,
                description: allowed ? undefined : (OPENAI_TRANSCRIBE_SET.has(model)
                    ? 'Requires a saved OpenAI key'
                    : 'Requires a saved Google AI key'),
            };
        });
    }, [settings.transcriptionMode, isTranscribeAllowed]);

    const llmOptions = useMemo(() => {
        if (settings.llmHost === 'local') {
            return LOCAL_LLM_MODELS.map((model) => ({value: model, label: formatLlmLabel(model)}));
        }
        const models: string[] = [
            ...(WINKY_LLM_MODELS as unknown as string[]),
            ...OPENAI_LLM_MODELS,
            ...(GEMINI_LLM_MODELS as unknown as string[]),
        ];
        return models.map((model) => {
            const allowed = isLlmAllowed(model);
            return {
                value: model,
                label: formatLlmLabel(model),
                disabled: !allowed,
                description: allowed ? undefined : (OPENAI_LLM_SET.has(model)
                    ? 'Requires a saved OpenAI key'
                    : 'Requires a saved Google AI key'),
            };
        });
    }, [settings.llmHost, isLlmAllowed]);

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
        if (!transcribeOptions.length) return;
        const currentAllowed = isTranscribeAllowed(apiTranscribeModel);
        if (currentAllowed) return;
        const fallback = transcribeOptions.find((option) => {
            const optionMeta = option as typeof option & { disabled?: boolean };
            return !optionMeta.disabled;
        });
        if (fallback) {
            void handleTranscriptionModelChange(fallback.value);
        }
    }, [settings.transcriptionMode, apiTranscribeModel, transcribeOptions, isTranscribeAllowed]);

    useEffect(() => {
        if (settings.llmHost !== 'api') return;
        if (!llmOptions.length) return;
        const currentAllowed = isLlmAllowed(apiLlmModel);
        if (currentAllowed) return;
        const fallback = llmOptions.find((option) => {
            const optionMeta = option as typeof option & { disabled?: boolean };
            return !optionMeta.disabled;
        });
        if (fallback) {
            void handleApiLlmModelChange(fallback.value);
        }
    }, [settings.llmHost, apiLlmModel, llmOptions, isLlmAllowed]);

    return (
        <div className="ai-settings">
            <section className="settings-card card">
                <h3 className="settings-card__title">Modes & Models</h3>
                <div className="ai-settings__grid ai-settings__grid--models">
                    <div className="settings-field">
                        <div className="ai-settings__select-wrapper">
                            <TextField
                                select
                                size="small"
                                label={'Transcription Mode'}
                                value={settings.transcriptionMode ?? 'api'}
                                onChange={(event) => handleTranscriptionModeChange(event.target.value as TranscriptionMode)}
                                fullWidth
                            >
                                {TRANSCRIPTION_MODE_OPTIONS.map((option) => (
                                    <MenuItem key={option.value} value={option.value}>
                                        {option.label}
                                    </MenuItem>
                                ))}
                            </TextField>
                            {settings.transcriptionMode === 'local' ? (
                                <IconButton
                                    size="small"
                                    className="ai-settings__select-icon"
                                    aria-label="Local transcription info"
                                    onClick={() => setInfoDialog('transcribe')}
                                >
                                    <InfoOutlinedIcon fontSize="small"/>
                                </IconButton>
                            ) : null}
                        </div>
                        {settings.transcriptionMode === 'local' ? (
                            <Box className="ai-settings__local-server" mt={-.8}>
                                {localStatus?.running && !localBusyPhase ? (
                                    <Box
                                        sx={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            borderRadius: 2,
                                            border: '0',
                                            backgroundColor: 'rgba(16,185,129,0.08)',
                                            px: 1.5,
                                            py: 1,
                                            gap: 1,
                                        }}
                                    >
                                        <Box sx={{display: 'flex', alignItems: 'center', gap: 1}}>
                                            <CheckCircleIcon fontSize="small" color="success"/>
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
                                                    <CircularProgress size={16} sx={{color: 'success.main'}}/>
                                                ) : (
                                                    <RestartAltIcon fontSize="small"/>
                                                )}
                                            </IconButton>
                                            <IconButton
                                                size="small"
                                                disabled={!!localAction}
                                                onClick={() => void handleLocalAction('stop', () => window.api.localSpeech.stop())}
                                                sx={{
                                                    color: localAction ? 'text.disabled' : 'text.primary',
                                                    '&:hover': {
                                                        color: 'error.main',
                                                        backgroundColor: 'rgba(239,68,68,0.12)'
                                                    },
                                                }}
                                            >
                                                {localAction === 'stop' ? (
                                                    <CircularProgress size={16} sx={{color: 'error.main'}}/>
                                                ) : (
                                                    <StopCircleIcon fontSize="small"/>
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
                                            border: '0',
                                            backgroundColor: 'rgba(107,114,128,0.08)',
                                            px: 1.5,
                                            py: 1,
                                            gap: 1,
                                        }}
                                    >
                                        <Box sx={{display: 'flex', alignItems: 'center', gap: 1}}>
                                            <StopCircleIcon fontSize="small" sx={{color: 'text.secondary'}}/>
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
                                                    <CircularProgress size={16} color="inherit"/>
                                                ) : (
                                                    <PlayArrowIcon fontSize="small"/>
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
                                        {localAction || localBusyPhase ?
                                            <CircularProgress size={16} color="inherit"/> : null}
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
                        <div className="ai-settings__select-wrapper">
                            <TextField
                                select
                                size="small"
                                fullWidth
                                label="Transcription model"
                                value={settings.transcriptionMode === 'local' ? localTranscribeModel : apiTranscribeModel}
                                onChange={(event) => {
                                    const val = event.target.value;
                                    if (settings.transcriptionMode === 'local') {
                                        void handleLocalWhisperChange(val);
                                    } else {
                                        void handleTranscriptionModelChange(val);
                                    }
                                }}
                                disabled={settings.transcriptionMode === 'local' && transcribeUnavailable}
                            >
                                {transcribeOptions.map((option) => {
                                    const optionMeta = option as typeof option & {
                                        disabled?: boolean;
                                        description?: string;
                                    };
                                    const optionDisabled = Boolean(optionMeta.disabled);
                                    const optionDescription = optionMeta.description;
                                    return (
                                        <MenuItem
                                            key={option.value}
                                            value={option.value}
                                            disabled={optionDisabled}
                                            sx={optionDisabled ? {opacity: 0.6} : undefined}
                                        >
                                            <Box sx={{display: 'flex', flexDirection: 'column', gap: 0.25}}>
                                                <span>{option.label}</span>
                                                {optionDescription ? (
                                                    <Typography variant="caption" color="text.secondary">
                                                        {optionDescription}
                                                    </Typography>
                                                ) : null}
                                            </Box>
                                        </MenuItem>
                                    );
                                })}
                            </TextField>
                            {settings.transcriptionMode === 'local' && !localModelWarming && localModelReady === true ? (
                                <span
                                    className="ai-settings__select-status ai-settings__select-status--success">Ready</span>
                            ) : null}
                            {settings.transcriptionMode === 'local' && !localModelWarming && localModelReady === false && !checkingLocalModel ? (
                                <span
                                    className="ai-settings__select-status ai-settings__select-status--warning">Download</span>
                            ) : null}
                        </div>
                        {settings.transcriptionMode === 'local' ? (
                            <div className="ai-settings__status-block -mt-2">
                                {transcribeUnavailable ? (
                                    <Typography variant="body2" mt={-1.1} ml={.2} color="warning.main">
                                        Install and start the local server to use local transcription.
                                    </Typography>
                                ) : null}
                                {!transcribeUnavailable && localWarmupHydrated && localModelWarming && !checkingLocalModel ? (
                                    <Typography variant="body2" color="warning.main"
                                                sx={{display: 'flex', alignItems: 'center', gap: 1}}>
                                        <CircularProgress size={16} thickness={5} sx={{color: 'warning.main'}}/>
                                        {selectedLocalMetadata
                                            ? `${selectedLocalMetadata.label} is warming up. Recording is temporarily disabled.`
                                            : 'Model is warming up. Recording is temporarily disabled.'}
                                    </Typography>
                                ) : null}
                                {!transcribeUnavailable && !checkingLocalModel && localModelReady === false ? (
                                    <Button
                                        variant="contained"
                                        size="small"
                                        color="primary"
                                        onClick={handleLocalModelDownload}
                                        disabled={downloadingLocalModel}
                                        startIcon={downloadingLocalModel ?
                                            <CircularProgress size={14} color="inherit"/> : undefined}
                                        sx={{mt: 0.5}}
                                    >
                                        {selectedLocalMetadata ? `Download ${selectedLocalMetadata.label}` : 'Download model'}
                                    </Button>
                                ) : null}
                                {/* Warmup is automatic now; no manual button needed */}
                                {localModelError ? (
                                    <Typography variant="body2" color="error" sx={{mt: 0.5}}>
                                        {localModelError}
                                    </Typography>
                                ) : null}
                            </div>
                        ) : null}
                    </div>

                    <div className="settings-field">
                        <div className="ai-settings__select-wrapper">
                            <TextField
                                select
                                size="small"
                                fullWidth
                                label="LLM Mode"
                                value={settings.llmHost ?? 'api'}
                                onChange={(event) => handleLlmHostChange(event.target.value as LlmHost)}
                            >
                                {LLM_HOST_OPTIONS.map((option) => (
                                    <MenuItem key={option.value} value={option.value}>
                                        {option.label}
                                    </MenuItem>
                                ))}
                            </TextField>
                            {settings.llmHost === 'local' ? (
                                <IconButton
                                    size="small"
                                    className="ai-settings__select-icon"
                                    aria-label="Local LLM info"
                                    onClick={() => setInfoDialog('llm')}
                                >
                                    <InfoOutlinedIcon fontSize="small"/>
                                </IconButton>
                            ) : null}
                        </div>
                    </div>

                    <div className="settings-field">
                        <div className="ai-settings__select-wrapper">
                            <TextField
                                select
                                size="small"
                                fullWidth
                                label="LLM model"
                                value={settings.llmHost === 'local' ? localLlmModel : apiLlmModel}
                                onChange={(event) => {
                                    const val = event.target.value;
                                    if (settings.llmHost === 'local') {
                                        void handleLocalLlmModelChange(val);
                                    } else {
                                        void handleApiLlmModelChange(val);
                                    }
                                }}
                                disabled={settings.llmHost === 'local' && (ollamaChecking || !ollamaInstalled)}
                            >
                                {llmOptions.map((option) => {
                                    const optionMeta = option as typeof option & {
                                        disabled?: boolean;
                                        description?: string;
                                    };
                                    const optionDisabled = Boolean(optionMeta.disabled);
                                    const optionDescription = optionMeta.description;
                                    return (
                                        <MenuItem
                                            key={option.value}
                                            value={option.value}
                                            disabled={optionDisabled}
                                            sx={optionDisabled ? {opacity: 0.6} : undefined}
                                        >
                                            <Box sx={{display: 'flex', flexDirection: 'column', gap: 0.25}}>
                                                <span>{option.label}</span>
                                                {optionDescription ? (
                                                    <Typography variant="caption" color="text.secondary">
                                                        {optionDescription}
                                                    </Typography>
                                                ) : null}
                                            </Box>
                                        </MenuItem>
                                    );
                                })}
                            </TextField>
                            {settings.llmHost === 'local' && !ollamaModelWarming && ollamaModelDownloaded === true ? (
                                <span
                                    className="ai-settings__select-status ai-settings__select-status--success">Ready</span>
                            ) : null}
                            {settings.llmHost === 'local' && !ollamaModelWarming && ollamaModelDownloaded === false && !ollamaModelChecking ? (
                                <span
                                    className="ai-settings__select-status ai-settings__select-status--warning">Download</span>
                            ) : null}
                        </div>
                        {settings.llmHost === 'local' ? (
                            <Box sx={{mt: -.4}} className="ai-settings__status-block">
                                {!ollamaChecking && ollamaInstalled === false ? (
                                    <Typography variant="body2" color="warning.main">
                                        Install Ollama CLI to enable local LLMs.
                                    </Typography>
                                ) : null}
                                {ollamaInstalled && !ollamaModelChecking && ollamaModelWarming ? (
                                    <Typography variant="body2" color="warning.main"
                                                sx={{display: 'flex', alignItems: 'center', gap: 1}}>
                                        <CircularProgress size={16} thickness={5} sx={{color: 'warning.main'}}/>
                                        {selectedLocalLlmLabel} is warming up.
                                    </Typography>
                                ) : null}
                                {ollamaInstalled && !ollamaModelChecking && ollamaModelDownloaded === false ? (
                                    <Button
                                        variant="contained"
                                        size="small"
                                        color="primary"
                                        onClick={handleOllamaDownload}
                                        disabled={ollamaDownloading}
                                        startIcon={ollamaDownloading ?
                                            <CircularProgress size={14} color="inherit"/> : undefined}
                                    >
                                        Download {selectedLocalLlmLabel}
                                    </Button>
                                ) : null}
                                {ollamaModelError ? (
                                    <Typography variant="body2" color="error" sx={{mt: 0.5}}>
                                        {ollamaModelError}
                                    </Typography>
                                ) : null}
                            </Box>
                        ) : null}
                    </div>

                </div>
            </section>

            {showApiKeys ? (
                <ProviderCredentialsSection
                    openaiKey={openaiKey}
                    googleKey={googleKey}
                    hasOpenAiKey={hasOpenAiKey}
                    hasGoogleKey={hasGoogleKey}
                    testing={providerTesting}
                    messages={providerTestMessage}
                    onOpenAiChange={setOpenaiKey}
                    onGoogleChange={setGoogleKey}
                    onOpenAiSave={saveOpenAi}
                    onGoogleSave={saveGoogle}
                    onTest={testProvider}
                />
            ) : null}

            <PromptSettingsSection
                transcriptionPrompt={transcriptionPrompt}
                llmPrompt={llmPrompt}
                onChangeTranscription={setTranscriptionPrompt}
                onChangeLlm={setLlmPrompt}
            />
            <TimeoutSettingsSection
                apiSttTimeout={apiSttTimeout}
                apiLlmTimeout={apiLlmTimeout}
                onChangeApiStt={(value) => setApiSttTimeout(clampTimeout(value))}
                onChangeApiLlm={(value) => setApiLlmTimeout(clampTimeout(value))}
            />
            <Dialog
                open={infoDialog === 'transcribe'}
                onClose={() => setInfoDialog(null)}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle>Local transcription</DialogTitle>
                <DialogContent dividers>
                    <Typography variant="body2" gutterBottom>
                        Whisper is fastest and most accurate on NVIDIA GPUs (RTX/GTX). CPU mode works, but Medium/Large
                        models will run significantly slower without a discrete GPU.
                    </Typography>
                    <Typography variant="body2" gutterBottom>
                        Approximate download sizes:
                    </Typography>
                    <Typography variant="body2" component="div">
                        • Tiny — ~75&nbsp;MB<br/>
                        • Base — ~141&nbsp;MB<br/>
                        • Small — ~463&nbsp;MB<br/>
                        • Medium — ~1.4&nbsp;GB<br/>
                        • Large v3 — ~3&nbsp;GB
                    </Typography>
                    <Typography variant="body2" sx={{mt: 2}}>
                        Audio never leaves your machine, so make sure you have enough free disk space and let the
                        download finish before starting a recording.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setInfoDialog(null)}>Got it</Button>
                </DialogActions>
            </Dialog>

            <Dialog
                open={infoDialog === 'llm'}
                onClose={() => setInfoDialog(null)}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle>Local LLM</DialogTitle>
                <DialogContent dividers>
                    <Typography variant="body2" gutterBottom>
                        Smaller local models already weigh 5–7&nbsp;GB, while meaningful ones easily reach 20–40&nbsp;GB
                        and require a powerful GPU with plenty of VRAM.
                    </Typography>
                    <Typography variant="body2" gutterBottom>
                        Generation speed scales with your GPU. On weak hardware or CPU-only setups responses will be
                        slow and may lock up the system.
                    </Typography>
                    <Typography variant="body2">
                        If you are unsure about your PC, prefer API keys (OpenAI / Gemini). They are easier to configure
                        and provide predictable latency without heavy downloads.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setInfoDialog(null)}>Got it</Button>
                </DialogActions>
            </Dialog>
        </div>
    );
};
