import {transcribeAudio} from './ai/transcription.client';
import {askChat, askChatStream} from './ai/llm.client';
import {logger} from './logger.service';

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
    logger.info('assistant', 'Starting audio to answer processing', { 
        audioSize: audio.length, 
        filename, 
        mime, 
        audioSeconds 
    });
    
    const text = await transcribeAudio(audio, filename, mime, audioSeconds);
    logger.info('assistant', 'Transcription completed, starting chat', { 
        textLength: text?.length || 0,
        transcribedText: text || ''
    });
    
    const answer = text ? await askChat(text) : '';
    logger.info('assistant', 'Audio to answer processing completed', { 
        textLength: text?.length || 0,
        answerLength: answer?.length || 0,
        transcribedText: text || '',
        chatResponse: answer || ''
    });
    
    return {text, answer};
}

export async function processAudioToAnswerStream(
    audio: Buffer,
    filename: string,
    mime: string,
    onDelta: (delta: string) => void,
    onDone?: () => void,
    audioSeconds?: number,
    options?: { signal?: AbortSignal; shouldCancel?: () => boolean }
): Promise<{ text: string }> {
    logger.info('assistant', 'Starting audio to answer stream processing', { 
        audioSize: audio.length, 
        filename, 
        mime, 
        audioSeconds 
    });
    
    const text = await transcribeAudio(audio, filename, mime, audioSeconds);
    logger.info('assistant', 'Transcription completed, starting chat stream', { 
        textLength: text?.length || 0,
        transcribedText: text || ''
    });
    
    if (!text) {
        if (onDone) onDone();
        return {text: ''};
    }
    await askChatStream(text, onDelta, onDone, options);
    logger.info('assistant', 'Audio to answer stream processing completed');
    return {text};
}

export async function transcribeAudioOnly(
    audio: Buffer,
    filename: string,
    mime: string,
    audioSeconds?: number
): Promise<{ text: string }> {
    logger.info('assistant', 'Starting transcription only', { 
        audioSize: audio.length, 
        filename, 
        mime, 
        audioSeconds 
    });
    
    const text = await transcribeAudio(audio, filename, mime, audioSeconds);
    logger.info('assistant', 'Transcription only completed', { 
        textLength: text?.length || 0,
        transcribedText: text || ''
    });
    
    return {text};
}

export async function askChatWithText(
    text: string,
    onDelta: (delta: string) => void,
    onDone?: () => void,
    options?: { signal?: AbortSignal; shouldCancel?: () => boolean }
): Promise<void> {
    logger.info('assistant', 'Starting chat with text', { 
        textLength: text?.length || 0,
        inputText: text || ''
    });
    
    if (!text) {
        if (onDone) onDone();
        return;
    }
    await askChatStream(text, onDelta, onDone, options);
    logger.info('assistant', 'Chat with text completed');
}

