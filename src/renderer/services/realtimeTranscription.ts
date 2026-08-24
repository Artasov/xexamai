import {isGoogleRealtimeTranscription} from './googleLiveContract';
import {
    isOpenAiRealtimeTranscription,
    isOpenAiRealtimeTranslation,
} from './openAiLiveContract';

export type RealtimeTranscriptionProvider = 'google' | 'openai';
export type RealtimeTranscriptionTarget = 'google' | 'openai-transcribe' | 'openai-translate';

export const getRealtimeTranscriptionTarget = (
    mode: string | undefined,
    model: string | undefined,
): RealtimeTranscriptionTarget | null => {
    if (isOpenAiRealtimeTranslation(mode, model)) return 'openai-translate';
    if (isOpenAiRealtimeTranscription(mode, model)) return 'openai-transcribe';
    if (isGoogleRealtimeTranscription(mode, model)) return 'google';
    return null;
};

export const getRealtimeTranscriptionProvider = (
    mode: string | undefined,
    model: string | undefined,
): RealtimeTranscriptionProvider | null => {
    const target = getRealtimeTranscriptionTarget(mode, model);
    if (target === 'openai-transcribe' || target === 'openai-translate') return 'openai';
    return target === 'google' ? 'google' : null;
};

export const isRealtimeTranscription = (
    mode: string | undefined,
    model: string | undefined,
): boolean => getRealtimeTranscriptionTarget(mode, model) !== null;
