import {settingsStore} from '../state/settingsStore';
import {setStatus} from '../ui/status';
import {normalizeLocalWhisperModel} from '../services/localSpeechModels';
import {TRANSCRIBE_API_MODELS} from '@shared/constants';
import {checkOllamaModelDownloaded, isOllamaModelDownloading, isOllamaModelWarming} from '../services/ollama';

const DEFAULT_API_MODEL = TRANSCRIBE_API_MODELS[0] ?? 'gpt-4o-mini-transcribe';
const DEFAULT_LOCAL_MODEL = 'base';

const hasText = (value?: string | null): boolean => Boolean((value ?? '').trim().length);

export const ensureTranscriptionReady = async (): Promise<boolean> => {
    let settings: any;
    try {
        settings = settingsStore.get();
    } catch {
        settings = await settingsStore.load();
    }
    const mode = settings.transcriptionMode || 'api';
    const apiModel = settings.transcriptionModel || DEFAULT_API_MODEL;

    if (mode === 'api') {
        const needsOpenAi = apiModel.startsWith('gpt');
        const needsGoogle = apiModel.startsWith('gemini');
        if (needsOpenAi && !hasText(settings.openaiApiKey)) {
            setStatus('Add an OpenAI API key first', 'error');
            return false;
        }
        if (needsGoogle && !hasText(settings.googleApiKey)) {
            setStatus('Add a Google AI API key first', 'error');
            return false;
        }
        return true;
    }

    if (!window.api?.localSpeech) {
        setStatus('Local speech bridge unavailable', 'error');
        return false;
    }
    let status: any = null;
    try {
        status = await window.api.localSpeech.getStatus();
    } catch {
        setStatus('Failed to fetch local speech status', 'error');
        return false;
    }
    if (!status?.installed) {
        setStatus('Install the local speech server first', 'error');
        return false;
    }
    if (!status.running) {
        setStatus('Start the local speech server first', 'error');
        return false;
    }

    const model = normalizeLocalWhisperModel(settings.localWhisperModel || DEFAULT_LOCAL_MODEL) || DEFAULT_LOCAL_MODEL;
    try {
        const downloaded = await window.api.localSpeech.checkModelDownloaded(model);
        if (!downloaded) {
            setStatus('Download the selected local transcription model', 'error');
            return false;
        }
    } catch {
        setStatus('Failed to verify local model', 'error');
        return false;
    }

    if (settings.llmHost === 'local') {
        const llmModel = settings.localLlmModel || settings.llmModel || 'gpt-oss:20b';
        try {
            const downloaded = await checkOllamaModelDownloaded(llmModel, {force: true});
            if (!downloaded) {
                setStatus('Download the selected local LLM model', 'error');
                return false;
            }
            if (isOllamaModelDownloading(llmModel)) {
                setStatus('Local LLM model is downloading, please wait', 'error');
                return false;
            }
            if (isOllamaModelWarming(llmModel)) {
                setStatus('Local LLM model is warming up, please wait', 'error');
                return false;
            }
        } catch {
            setStatus('Failed to verify local LLM model', 'error');
            return false;
        }
    }
    return true;
};
