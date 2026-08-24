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
    realtimeTranslation: false,
};

type TranslationView = 'translated' | 'source';

export function useRendererSession() {
    const sessionRef = useRef<RendererSession | null>(null);
    const questionRef = useRef('');
    const translationActiveRef = useRef(false);
    const translationViewRef = useRef<TranslationView>('translated');
    const translationTextRef = useRef({source: '', translated: ''});
    const promptImagesRef = useRef<PromptImageAttachment[]>([]);
    const [question, setQuestionState] = useState('');
    const [translationView, setTranslationViewState] = useState<TranslationView>('translated');
    const [promptImages, setPromptImagesState] = useState<PromptImageAttachment[]>([]);
    const [ready, setReady] = useState(false);
    const [settings, setSettings] = useState<RendererSettingsSnapshot>(DEFAULT_SETTINGS);
    const [audioInput, setAudioInput] = useState<AudioInputType>('microphone');
    const [audioSwitching, setAudioSwitching] = useState(false);

    const setQuestion = useCallback((value: string | ((current: string) => string)) => {
        setQuestionState((current) => {
            const next = typeof value === 'function' ? value(current) : value;
            questionRef.current = next;
            if (translationActiveRef.current) {
                translationTextRef.current = {
                    ...translationTextRef.current,
                    [translationViewRef.current]: next,
                };
            }
            return next;
        });
    }, []);

    const updateRealtimeTranscript = useCallback((previous: string, next: string) => {
        setQuestion((current) => reconcileRealtimeTranscript(current, previous, next));
    }, [setQuestion]);

    const updateRealtimeTranslation = useCallback((update: {
        sourcePrevious: string;
        sourceNext: string;
        translatedPrevious: string;
        translatedNext: string;
    }) => {
        const current = translationTextRef.current;
        const next = {
            source: reconcileRealtimeTranscript(
                current.source,
                update.sourcePrevious,
                update.sourceNext,
            ),
            translated: reconcileRealtimeTranscript(
                current.translated,
                update.translatedPrevious,
                update.translatedNext,
            ),
        };
        translationTextRef.current = next;
        if (!translationActiveRef.current) return;
        const visible = next[translationViewRef.current];
        questionRef.current = visible;
        setQuestionState(visible);
    }, []);

    const toggleTranslationView = useCallback(() => {
        if (!translationActiveRef.current) return;
        const nextView: TranslationView = translationViewRef.current === 'translated'
            ? 'source'
            : 'translated';
        translationViewRef.current = nextView;
        setTranslationViewState(nextView);
        const visible = translationTextRef.current[nextView];
        questionRef.current = visible;
        setQuestionState(visible);
    }, []);

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
        if (translationActiveRef.current && questionRef.current.trim() === text.trim()) {
            translationTextRef.current = {source: '', translated: ''};
            questionRef.current = '';
            setQuestionState('');
        } else {
            clearQuestionIfUnchanged(text);
        }
        const submitted = new Set(imageIds);
        setPromptImages((current) => current.filter((image) => !submitted.has(image.id)));
    }, [clearQuestionIfUnchanged, setPromptImages]);

    const setAudioInputPresentation = useCallback((type: AudioInputType, switching: boolean) => {
        setAudioInput(type);
        setAudioSwitching(switching);
    }, []);

    const setSettingsSnapshot = useCallback((snapshot: RendererSettingsSnapshot) => {
        const wasTranslation = translationActiveRef.current;
        translationActiveRef.current = snapshot.realtimeTranslation;
        if (!wasTranslation && snapshot.realtimeTranslation) {
            translationViewRef.current = 'translated';
            setTranslationViewState('translated');
            translationTextRef.current = {source: '', translated: questionRef.current};
        } else if (wasTranslation && !snapshot.realtimeTranslation) {
            translationTextRef.current = {source: '', translated: ''};
            translationViewRef.current = 'translated';
            setTranslationViewState('translated');
        }
        setSettings(snapshot);
    }, []);

    useEffect(() => {
        const session = new RendererSession({
            updateRealtimeTranscript,
            updateRealtimeTranslation,
            restoreQuestionIfEmpty,
            getQuestion: () => questionRef.current,
            getPromptImages: () => promptImagesRef.current,
            addPromptImages,
            clearSubmittedPrompt,
            setAudioInputPresentation,
            setSettingsSnapshot,
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
        updateRealtimeTranslation,
        addPromptImages,
        clearSubmittedPrompt,
        restoreQuestionIfEmpty,
        setAudioInputPresentation,
        setSettingsSnapshot,
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
        translationView,
        toggleTranslationView,
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
