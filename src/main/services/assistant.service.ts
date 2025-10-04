import {transcribeAudio} from './openai/transcription.client';
import {askChat, askChatStream} from './openai/chatgpt.client';

export type AssistantResult = {
    text: string;
    answer: string;
};

export async function processAudioToAnswer(
    audio: Buffer,
    filename: string,
    mime: string,
    audioSeconds?: number
): Promise<AssistantResult> {
    const text = await transcribeAudio(audio, filename, mime, audioSeconds);
    const answer = text ? await askChat(text) : '';
    return {text, answer};
}

export async function processAudioToAnswerStream(
    audio: Buffer,
    filename: string,
    mime: string,
    onDelta: (delta: string) => void,
    onDone?: () => void,
    audioSeconds?: number
): Promise<{ text: string }> {
    const text = await transcribeAudio(audio, filename, mime, audioSeconds);
    if (!text) {
        if (onDone) onDone();
        return {text: ''};
    }
    await askChatStream(text, onDelta, onDone);
    return {text};
}

export async function transcribeAudioOnly(
    audio: Buffer,
    filename: string,
    mime: string,
    audioSeconds?: number
): Promise<{ text: string }> {
    const text = await transcribeAudio(audio, filename, mime, audioSeconds);
    return {text};
}

export async function askChatWithText(
    text: string,
    onDelta: (delta: string) => void,
    onDone?: () => void
): Promise<void> {
    if (!text) {
        if (onDone) onDone();
        return;
    }
    await askChatStream(text, onDelta, onDone);
}

