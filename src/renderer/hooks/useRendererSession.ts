import {useCallback, useEffect, useRef, useState} from 'react';
import {
    RendererSession,
    type RendererAutoPromptSnapshot,
    type RendererSettingsSnapshot,
} from '../renderer';
import type {
    AudioInputType,
    RealtimeAcknowledgementUpdate,
} from '../app/streamController';
import {setStatus} from '../ui/status';
import {
    appendSubmittedPrompt,
    composeRealtimeTranslationPrompt,
    extractRealtimeSourceEdit,
    reconcileRealtimeAcknowledgement,
    reconcileRealtimeTranslationAcknowledgement,
    reconcileRealtimeTranscript,
    reconcileRealtimeTextWithEdit,
    removeSubmittedPromptPrefix,
} from '../utils/realtimeTranscript';
import type {PromptImageAttachment} from '@shared/ipc';
import {
    MAX_PROMPT_IMAGE_BASE64_CHARS,
    MAX_PROMPT_IMAGES,
    imageFileToPromptAttachment,
} from '../utils/promptImages';
import {checkFeatureAccess, showFeatureAccessModal} from '../ui/featureAccessModal';
import {toast} from 'react-toastify';
import {state} from '../state/appState';

const DEFAULT_SETTINGS: RendererSettingsSnapshot = {
    durations: [5, 10, 15, 20, 30, 60],
    durationHotkeys: {},
    realtimeTranscription: false,
    realtimeTranslation: false,
};

type TranslationView = 'translated' | 'source';
type QuestionUpdate = string | ((current: string) => string);

export function useRendererSession() {
    const sessionRef = useRef<RendererSession | null>(null);
    const autoModeToggleRef = useRef<Promise<void> | null>(null);
    const questionRef = useRef('');
    const translationActiveRef = useRef(false);
    const translationViewRef = useRef<TranslationView>('translated');
    const translationTextRef = useRef({source: '', translated: ''});
    const translationProviderTextRef = useRef({source: '', translated: ''});
    const translationSourceEditRef = useRef('');
    const translationTranslatedEditRef = useRef('');
    const promptImagesRef = useRef<PromptImageAttachment[]>([]);
    const [question, setQuestionState] = useState('');
    const [translationView, setTranslationViewState] = useState<TranslationView>('translated');
    const [promptImages, setPromptImagesState] = useState<PromptImageAttachment[]>([]);
    const [ready, setReady] = useState(false);
    const [autoModeEnabled, setAutoModeEnabled] = useState(false);
    const [autoModeSwitching, setAutoModeSwitching] = useState(false);
    const [settings, setSettings] = useState<RendererSettingsSnapshot>(DEFAULT_SETTINGS);
    const [audioInput, setAudioInput] = useState<AudioInputType>('microphone');
    const [audioSwitching, setAudioSwitching] = useState(false);

    const applyQuestion = useCallback((value: QuestionUpdate, userInitiated: boolean) => {
        const next = typeof value === 'function' ? value(questionRef.current) : value;
        questionRef.current = next;
        if (translationActiveRef.current) {
            const view = translationViewRef.current;
            translationTextRef.current = {
                ...translationTextRef.current,
                [view]: next,
            };
            if (userInitiated && view === 'source') {
                translationSourceEditRef.current = extractRealtimeSourceEdit(
                    translationProviderTextRef.current.source,
                    next,
                );
            } else if (userInitiated && view === 'translated') {
                translationTranslatedEditRef.current = extractRealtimeSourceEdit(
                    translationProviderTextRef.current.translated,
                    next,
                );
            }
        }
        setQuestionState(next);
    }, []);

    const setQuestion = useCallback((value: QuestionUpdate) => {
        applyQuestion(value, true);
    }, [applyQuestion]);

    const setQuestionInternal = useCallback((value: QuestionUpdate) => {
        applyQuestion(value, false);
    }, [applyQuestion]);

    const updateRealtimeTranscript = useCallback((previous: string, next: string) => {
        // Keep the canonical ref ahead of React rendering. Auto endpointing can
        // run synchronously in the same native event callback.
        setQuestionInternal((current) => reconcileRealtimeTranscript(current, previous, next));
    }, [setQuestionInternal]);

    const updateRealtimeTranslation = useCallback((update: {
        sourcePrevious: string;
        sourceNext: string;
        translatedPrevious: string;
        translatedNext: string;
    }) => {
        const current = translationTextRef.current;
        const providerCurrent = translationProviderTextRef.current;
        const providerNext = {
            source: reconcileRealtimeTranscript(
                providerCurrent.source,
                update.sourcePrevious,
                update.sourceNext,
            ),
            translated: reconcileRealtimeTranscript(
                providerCurrent.translated,
                update.translatedPrevious,
                update.translatedNext,
            ),
        };
        const next = {
            source: reconcileRealtimeTextWithEdit(
                current.source,
                providerCurrent.source,
                providerNext.source,
                translationSourceEditRef.current,
            ),
            translated: reconcileRealtimeTextWithEdit(
                current.translated,
                providerCurrent.translated,
                providerNext.translated,
                translationTranslatedEditRef.current,
            ),
        };
        translationProviderTextRef.current = providerNext;
        translationTextRef.current = next;
        if (!translationActiveRef.current) return;
        const visible = next[translationViewRef.current];
        questionRef.current = visible;
        setQuestionState(visible);
    }, []);

    const applyRealtimeAcknowledgement = useCallback((update: RealtimeAcknowledgementUpdate) => {
        if (update.target === 'openai-translate' && translationActiveRef.current) {
            // Replace both provider channels atomically. Source and translated
            // events can arrive at different times while the LLM dispatch is
            // awaiting settings/IPC, so clearing only the visible textarea can
            // otherwise either resurrect submitted text or discard the hidden
            // channel's newer suffix.
            const current = translationTextRef.current;
            const next = reconcileRealtimeTranslationAcknowledgement(current, update);
            const view = translationViewRef.current;
            translationTextRef.current = next;
            translationProviderTextRef.current = {
                source: update.source,
                translated: update.translated,
            };
            translationSourceEditRef.current = extractRealtimeSourceEdit(update.source, next.source);
            translationTranslatedEditRef.current = extractRealtimeSourceEdit(
                update.translated,
                next.translated,
            );
            const visible = next[view];
            questionRef.current = visible;
            setQuestionState(visible);
            return;
        }

        const next = reconcileRealtimeAcknowledgement(
            questionRef.current,
            update.submittedText || update.acknowledgedTranscript,
            update.transcript,
        );
        questionRef.current = next;
        setQuestionState(next);
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
        setQuestionInternal((current) => current.trim() ? current : text);
    }, [setQuestionInternal]);

    const clearQuestionIfUnchanged = useCallback((text: string) => {
        setQuestionInternal((current) => current.trim() === text.trim() ? '' : current);
    }, [setQuestionInternal]);

    const setPromptImages = useCallback((value: PromptImageAttachment[] | ((current: PromptImageAttachment[]) => PromptImageAttachment[])) => {
        const next = typeof value === 'function' ? value(promptImagesRef.current) : value;
        promptImagesRef.current = next;
        setPromptImagesState(next);
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

    const restorePromptImages = useCallback((images: PromptImageAttachment[]) => {
        if (!images.length) return;
        setPromptImages((current) => {
            const restoredIds = new Set(images.map((image) => image.id));
            const candidates = [
                ...images,
                ...current.filter((image) => !restoredIds.has(image.id)),
            ];
            const next: PromptImageAttachment[] = [];
            let encodedSize = 0;
            for (const image of candidates) {
                if (
                    next.length >= MAX_PROMPT_IMAGES
                    || encodedSize + image.base64.length > MAX_PROMPT_IMAGE_BASE64_CHARS
                ) break;
                next.push(image);
                encodedSize += image.base64.length;
            }
            if (next.length < candidates.length) {
                toast.info('Some newer attachments were removed to restore the interrupted prompt.');
            }
            return next;
        });
    }, [setPromptImages]);

    const addPastedImages = useCallback(async (files: File[]) => {
        if (!files.length) return;
        if (state.isProcessing) {
            toast.info('Wait for the current operation before attaching an image.');
            return;
        }
        if (!checkFeatureAccess('screen_processing')) {
            showFeatureAccessModal('screen_processing');
            return;
        }
        try {
            const images = await Promise.all(files.slice(0, MAX_PROMPT_IMAGES).map(imageFileToPromptAttachment));
            // Encoding can overlap the moment an automatic submission takes
            // ownership of the current attachments. Do not admit a late image
            // that would compete with a prompt being restored after cancellation.
            if (state.isProcessing) {
                toast.info('Wait for the current operation before attaching an image.');
                return;
            }
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
            translationProviderTextRef.current = {source: '', translated: ''};
            translationSourceEditRef.current = '';
            translationTranslatedEditRef.current = '';
            questionRef.current = '';
            setQuestionState('');
        } else {
            clearQuestionIfUnchanged(text);
        }
        const submitted = new Set(imageIds);
        setPromptImages((current) => current.filter((image) => !submitted.has(image.id)));
    }, [clearQuestionIfUnchanged, setPromptImages]);

    const getAutoPromptSnapshot = useCallback((): RendererAutoPromptSnapshot => {
        const realtimeTranslation = translationActiveRef.current;
        const translation = translationTextRef.current;
        const submittedText = realtimeTranslation
            ? composeRealtimeTranslationPrompt(translation.translated, translationSourceEditRef.current)
            : questionRef.current;
        return {
            text: submittedText,
            visibleText: questionRef.current,
            images: promptImagesRef.current.map((image) => ({...image})),
            realtimeTranslation,
            translationView: realtimeTranslation ? translationViewRef.current : undefined,
            sourceText: realtimeTranslation ? translation.source : undefined,
            translatedText: realtimeTranslation ? translation.translated : undefined,
            sourceEdit: realtimeTranslation ? translationSourceEditRef.current : undefined,
            providerSourceText: realtimeTranslation ? translationProviderTextRef.current.source : undefined,
            translatedEdit: realtimeTranslation ? translationTranslatedEditRef.current : undefined,
            providerTranslatedText: realtimeTranslation ? translationProviderTextRef.current.translated : undefined,
        };
    }, []);

    const restoreAutoPrompt = useCallback((snapshot: RendererAutoPromptSnapshot) => {
        if (translationActiveRef.current && snapshot.realtimeTranslation) {
            const current = translationTextRef.current;
            const next = {
                source: appendSubmittedPrompt(current.source, snapshot.sourceText || snapshot.visibleText),
                translated: appendSubmittedPrompt(
                    current.translated,
                    snapshot.translatedText,
                ),
            };
            translationTextRef.current = next;
            translationProviderTextRef.current = {
                source: appendSubmittedPrompt(
                    translationProviderTextRef.current.source,
                    snapshot.providerSourceText,
                ),
                translated: appendSubmittedPrompt(
                    translationProviderTextRef.current.translated,
                    snapshot.providerTranslatedText,
                ),
            };
            translationSourceEditRef.current = snapshot.sourceEdit || '';
            translationTranslatedEditRef.current = snapshot.translatedEdit || '';
            const visible = next[translationViewRef.current];
            questionRef.current = visible;
            setQuestionState(visible);
        } else {
            setQuestionInternal((current) => appendSubmittedPrompt(current, snapshot.text));
        }
        restorePromptImages(snapshot.images);
    }, [restorePromptImages, setQuestionInternal]);

    const clearAutoSubmittedPrompt = useCallback((snapshot: RendererAutoPromptSnapshot) => {
        if (translationActiveRef.current && snapshot.realtimeTranslation) {
            const current = translationTextRef.current;
            const withoutActualPrompt = removeSubmittedPromptPrefix(current.translated, snapshot.text);
            const next = {
                source: removeSubmittedPromptPrefix(current.source, snapshot.sourceText || snapshot.visibleText),
                translated: withoutActualPrompt === current.translated
                    ? removeSubmittedPromptPrefix(current.translated, snapshot.translatedText)
                    : withoutActualPrompt,
            };
            translationTextRef.current = next;
            translationProviderTextRef.current = {source: '', translated: ''};
            translationSourceEditRef.current = '';
            translationTranslatedEditRef.current = '';
            const visible = next[translationViewRef.current];
            questionRef.current = visible;
            setQuestionState(visible);
        } else {
            // text is authoritative: RendererSession may have selected a newer
            // canonical provider snapshot than the last painted textarea value.
            setQuestionInternal((current) => removeSubmittedPromptPrefix(current, snapshot.text));
        }
        const submittedImages = new Set(snapshot.images.map((image) => image.id));
        setPromptImages((current) => current.filter((image) => !submittedImages.has(image.id)));
    }, [setPromptImages, setQuestionInternal]);

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
            translationProviderTextRef.current = {source: '', translated: ''};
            translationSourceEditRef.current = '';
            translationTranslatedEditRef.current = questionRef.current.trim();
        } else if (wasTranslation && !snapshot.realtimeTranslation) {
            translationTextRef.current = {source: '', translated: ''};
            translationProviderTextRef.current = {source: '', translated: ''};
            translationSourceEditRef.current = '';
            translationTranslatedEditRef.current = '';
            translationViewRef.current = 'translated';
            setTranslationViewState('translated');
        }
        setSettings(snapshot);
    }, []);

    useEffect(() => {
        const session = new RendererSession({
            updateRealtimeTranscript,
            updateRealtimeTranslation,
            applyRealtimeAcknowledgement,
            restoreQuestionIfEmpty,
            getQuestion: () => questionRef.current,
            getPromptImages: () => promptImagesRef.current,
            getAutoPromptSnapshot,
            restoreAutoPrompt,
            restoreAutoPromptImages: restorePromptImages,
            clearAutoSubmittedPrompt,
            addPromptImages,
            clearSubmittedPrompt,
            setAudioInputPresentation,
            setSettingsSnapshot,
            setAutoModeEnabled,
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
        applyRealtimeAcknowledgement,
        addPromptImages,
        clearSubmittedPrompt,
        getAutoPromptSnapshot,
        restoreAutoPrompt,
        restorePromptImages,
        clearAutoSubmittedPrompt,
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
    const toggleAutoMode = useCallback(async () => {
        if (autoModeToggleRef.current) return;
        setAutoModeSwitching(true);
        const operation = Promise.resolve(sessionRef.current?.toggleAutoMode());
        autoModeToggleRef.current = operation;
        try {
            await operation;
        } finally {
            if (autoModeToggleRef.current === operation) {
                autoModeToggleRef.current = null;
                setAutoModeSwitching(false);
            }
        }
    }, []);

    return {
        ready,
        autoModeEnabled,
        autoModeSwitching,
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
        toggleAutoMode,
    };
}
