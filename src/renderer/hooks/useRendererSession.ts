import {useCallback, useEffect, useRef, useState} from 'react';
import {RendererSession, type RendererSettingsSnapshot} from '../renderer';
import type {AudioInputType} from '../app/streamController';
import {setStatus} from '../ui/status';
import {reconcileRealtimeTranscript} from '../utils/realtimeTranscript';

const DEFAULT_SETTINGS: RendererSettingsSnapshot = {
    durations: [5, 10, 15, 20, 30, 60],
    durationHotkeys: {},
};

export function useRendererSession() {
    const sessionRef = useRef<RendererSession | null>(null);
    const questionRef = useRef('');
    const [question, setQuestionState] = useState('');
    const [ready, setReady] = useState(false);
    const [settings, setSettings] = useState<RendererSettingsSnapshot>(DEFAULT_SETTINGS);
    const [audioInput, setAudioInput] = useState<AudioInputType>('microphone');
    const [audioSwitching, setAudioSwitching] = useState(false);

    const setQuestion = useCallback((value: string | ((current: string) => string)) => {
        setQuestionState((current) => {
            const next = typeof value === 'function' ? value(current) : value;
            questionRef.current = next;
            return next;
        });
    }, []);

    const updateRealtimeTranscript = useCallback((previous: string, next: string) => {
        setQuestion((current) => reconcileRealtimeTranscript(current, previous, next));
    }, [setQuestion]);

    const restoreQuestionIfEmpty = useCallback((text: string) => {
        setQuestion((current) => current.trim() ? current : text);
    }, [setQuestion]);

    const clearQuestionIfUnchanged = useCallback((text: string) => {
        setQuestion((current) => current.trim() === text.trim() ? '' : current);
    }, [setQuestion]);

    const setAudioInputPresentation = useCallback((type: AudioInputType, switching: boolean) => {
        setAudioInput(type);
        setAudioSwitching(switching);
    }, []);

    useEffect(() => {
        const session = new RendererSession({
            updateRealtimeTranscript,
            restoreQuestionIfEmpty,
            getQuestion: () => questionRef.current,
            clearQuestionIfUnchanged,
            setAudioInputPresentation,
            setSettingsSnapshot: setSettings,
            setReady,
        });
        sessionRef.current = session;
        void session.start().catch((error) => {
            console.error(error);
            setStatus('Initialization error', 'error');
        });

        return () => {
            if (sessionRef.current === session) sessionRef.current = null;
            void session.dispose();
        };
    }, [
        updateRealtimeTranscript,
        clearQuestionIfUnchanged,
        restoreQuestionIfEmpty,
        setAudioInputPresentation,
    ]);

    const toggleRecording = useCallback(() => sessionRef.current?.toggleRecording(), []);
    const askWindow = useCallback((seconds: number) => sessionRef.current?.askWindow(seconds), []);
    const toggleAudio = useCallback(() => sessionRef.current?.toggleAudioInput(), []);
    const captureScreenshot = useCallback(() => sessionRef.current?.captureScreenshot(), []);
    const stopActive = useCallback(() => sessionRef.current?.stopActiveOperation(), []);
    const sendQuestion = useCallback(async () => {
        const value = questionRef.current.trim();
        if (!value) return false;
        const started = await sessionRef.current?.sendQuestion(value);
        if (started) clearQuestionIfUnchanged(value);
        return !!started;
    }, [clearQuestionIfUnchanged]);

    return {
        ready,
        question,
        setQuestion,
        settings,
        audioInput,
        audioSwitching,
        toggleRecording,
        askWindow,
        toggleAudio,
        captureScreenshot,
        stopActive,
        sendQuestion,
    };
}
