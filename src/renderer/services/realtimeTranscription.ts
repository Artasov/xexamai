import {isGoogleRealtimeTranscription} from './googleLiveContract';
import {isOpenAiRealtimeTranscription} from './openAiLiveContract';

export type RealtimeTranscriptionProvider = 'google' | 'openai';

export const getRealtimeTranscriptionProvider = (
    mode: string | undefined,
    model: string | undefined,
): RealtimeTranscriptionProvider | null => {
    if (isOpenAiRealtimeTranscription(mode, model)) return 'openai';
    if (isGoogleRealtimeTranscription(mode, model)) return 'google';
    return null;
};

export const isRealtimeTranscription = (
    mode: string | undefined,
    model: string | undefined,
): boolean => getRealtimeTranscriptionProvider(mode, model) !== null;
