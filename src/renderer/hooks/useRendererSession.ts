import {useCallback, useEffect, useRef, useState} from 'react';
import {RendererSession, type RendererSettingsSnapshot} from '../renderer';
import type {AudioInputType} from '../app/streamController';
import {setStatus} from '../ui/status';
import {reconcileRealtimeTranscript} from '../utils/realtimeTranscript';
import type {PromptImageAttachment} from '@shared/ipc';
import {
    MAX_PROMPT_IMAGE_BASE64_CHARS,
    MAX_PROMPT_IMAGES,
    imageFileToPromptAttachment,
} from '../utils/promptImages';
import {checkFeatureAccess, showFeatureAccessModal} from '../ui/featureAccessModal';
import {toast} from 'react-toastify';

const DEFAULT_SETTINGS: RendererSettingsSnapshot = {
    durations: [5, 10, 15, 20, 30, 60],
    durationHotkeys: {},
    realtimeTranscription: false,
};

export function useRendererSession() {
    const sessionRef = useRef<RendererSession | null>(null);
    const questionRef = useRef('');
    const promptImagesRef = useRef<PromptImageAttachment[]>([]);
    const [question, setQuestionState] = useState('');
    const [promptImages, setPromptImagesState] = useState<PromptImageAttachment[]>([]);
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

    const setPromptImages = useCallback((value: PromptImageAttachment[] | ((current: PromptImageAttachment[]) => PromptImageAttachment[])) => {
        setPromptImagesState((current) => {
            const next = typeof value === 'function' ? value(current) : value;
            promptImagesRef.current = next;
            return next;
        });
    }, []);

    const addPromptImages = useCallback((images: PromptImageAttachment[]) => {
        if (!images.length) return;
        setPromptImages((current) => {
            const available = Math.max(0, MAX_PROMPT_IMAGES - current.length);
            if (images.length > available) toast.info(`You can attach up to ${MAX_PROMPT_IMAGES} images.`);
            const knownIds = new Set(current.map((image) => image.id));
            const next = [...current];
            let encodedSize = current.reduce((sum, image) => sum + image.base64.length, 0);
            for (const image of images.slice(0, available)) {
                if (knownIds.has(image.id)) continue;
                if (encodedSize + image.base64.length > MAX_PROMPT_IMAGE_BASE64_CHARS) {
                    toast.info('The combined image attachments are too large.');
                    break;
                }
                knownIds.add(image.id);
                encodedSize += image.base64.length;
                next.push(image);
            }
            return next;
        });
    }, [setPromptImages]);

    const addPastedImages = useCallback(async (files: File[]) => {
        if (!files.length) return;
        if (!checkFeatureAccess('screen_processing')) {
            showFeatureAccessModal('screen_processing');
            return;
        }
        try {
            const images = await Promise.all(files.slice(0, MAX_PROMPT_IMAGES).map(imageFileToPromptAttachment));
            addPromptImages(images);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Unable to paste image.');
        }
    }, [addPromptImages]);

    const removePromptImage = useCallback((id: string) => {
        setPromptImages((current) => current.filter((image) => image.id !== id));
    }, [setPromptImages]);

    const clearSubmittedPrompt = useCallback((text: string, imageIds: string[]) => {
        clearQuestionIfUnchanged(text);
        const submitted = new Set(imageIds);
        setPromptImages((current) => current.filter((image) => !submitted.has(image.id)));
    }, [clearQuestionIfUnchanged, setPromptImages]);

    const setAudioInputPresentation = useCallback((type: AudioInputType, switching: boolean) => {
        setAudioInput(type);
        setAudioSwitching(switching);
    }, []);

    useEffect(() => {
        const session = new RendererSession({
            updateRealtimeTranscript,
            restoreQuestionIfEmpty,
            getQuestion: () => questionRef.current,
            getPromptImages: () => promptImagesRef.current,
            addPromptImages,
            clearSubmittedPrompt,
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
        addPromptImages,
        clearSubmittedPrompt,
        restoreQuestionIfEmpty,
        setAudioInputPresentation,
    ]);

    const toggleRecording = useCallback(() => sessionRef.current?.toggleRecording(), []);
    const askWindow = useCallback((seconds: number) => sessionRef.current?.askWindow(seconds), []);
    const toggleAudio = useCallback(() => sessionRef.current?.toggleAudioInput(), []);
    const captureScreenshot = useCallback(() => sessionRef.current?.captureScreenshot(), []);
    const stopActive = useCallback(() => sessionRef.current?.stopActiveOperation(), []);
    const sendQuestion = useCallback(() => sessionRef.current?.sendQuestion(), []);

    return {
        ready,
        question,
        setQuestion,
        promptImages,
        addPastedImages,
        removePromptImage,
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
