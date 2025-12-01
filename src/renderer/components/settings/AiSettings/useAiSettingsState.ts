// noinspection JSUnusedGlobalSymbols

import {useEffect, useRef, useState} from 'react';
import type {FastWhisperStatus} from '@shared/ipc';
import {useSettingsContext} from '../SettingsView/SettingsView';

type TimeoutRef = ReturnType<typeof useRef<ReturnType<typeof setTimeout> | null>>;
type BooleanRef = ReturnType<typeof useRef<boolean>>;
type StringRef = ReturnType<typeof useRef<string | null>>;

export type LocalAction = 'install' | 'start' | 'restart' | 'reinstall' | 'stop';

export type AiSettingsState = {
    apiSttTimeout: number;
    apiLlmTimeout: number;
    screenTimeout: number;
    transcriptionPrompt: string;
    llmPrompt: string;
    localStatus: FastWhisperStatus | null;
    localAction: LocalAction | null;
    localModelReady: boolean | null;
    checkingLocalModel: boolean;
    downloadingLocalModel: boolean;
    localModelError: string | null;
    localModelWarming: boolean;
    localWarmupHydrated: boolean;
    localWarmupDebounceRef: TimeoutRef;
    localWarmupPendingRef: BooleanRef;
    infoDialog: 'transcribe' | 'llm' | null;
    ollamaInstalled: boolean | null;
    ollamaChecking: boolean;
    ollamaModelDownloaded: boolean | null;
    ollamaModelChecking: boolean;
    ollamaDownloading: boolean;
    ollamaModelError: string | null;
    ollamaModelWarming: boolean;
    lastLocalWarmupRef: StringRef;
    localStatusDebounceRef: TimeoutRef;
};

export function useAiSettingsState() {
    const {settings, patchLocal} = useSettingsContext();

    const [apiSttTimeout, setApiSttTimeout] = useState(settings.apiSttTimeoutMs ?? 30000);
    const [apiLlmTimeout, setApiLlmTimeout] = useState(settings.apiLlmTimeoutMs ?? 30000);
    const [screenTimeout, setScreenTimeout] = useState(settings.screenProcessingTimeoutMs ?? 50000);
    const [transcriptionPrompt, setTranscriptionPrompt] = useState(settings.transcriptionPrompt ?? '');
    const [llmPrompt, setLlmPrompt] = useState(settings.llmPrompt ?? '');

    const timeoutSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const promptSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    useEffect(() => {
        setApiSttTimeout(settings.apiSttTimeoutMs ?? 30000);
        setApiLlmTimeout(settings.apiLlmTimeoutMs ?? 30000);
        setScreenTimeout(settings.screenProcessingTimeoutMs ?? 50000);
        setTranscriptionPrompt(settings.transcriptionPrompt ?? '');
        setLlmPrompt(settings.llmPrompt ?? '');
    }, [
        settings.apiLlmTimeoutMs,
        settings.apiSttTimeoutMs,
        settings.screenProcessingTimeoutMs,
        settings.transcriptionPrompt,
        settings.llmPrompt,
    ]);

    return {
        state: {
            apiSttTimeout,
            apiLlmTimeout,
            screenTimeout,
            transcriptionPrompt,
            llmPrompt,
            localStatus,
            localAction,
            localModelReady,
            checkingLocalModel,
            downloadingLocalModel,
            localModelError,
            localModelWarming,
            localWarmupHydrated,
            localWarmupDebounceRef,
            localWarmupPendingRef,
            infoDialog,
            ollamaInstalled,
            ollamaChecking,
            ollamaModelDownloaded,
            ollamaModelChecking,
            ollamaDownloading,
            ollamaModelError,
            ollamaModelWarming,
            lastLocalWarmupRef,
            localStatusDebounceRef,
        } satisfies AiSettingsState,
        setters: {
            setApiSttTimeout,
            setApiLlmTimeout,
            setScreenTimeout,
            setTranscriptionPrompt,
            setLlmPrompt,
            setLocalStatus,
            setLocalAction,
            setLocalModelReady,
            setCheckingLocalModel,
            setDownloadingLocalModel,
            setLocalModelError,
            setLocalModelWarming,
            setLocalWarmupHydrated,
            setInfoDialog,
            setOllamaInstalled,
            setOllamaChecking,
            setOllamaModelDownloaded,
            setOllamaModelChecking,
            setOllamaDownloading,
            setOllamaModelError,
            setOllamaModelWarming,
            setOllamaModels,
        },
        refs: {
            timeoutSaveRef,
            promptSaveRef,
        },
        settingsContext: {
            settings,
            patchLocal,
        },
    };
}
