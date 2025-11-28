import {LOCAL_LLM_SIZE_HINTS} from '@shared/constants';
import {normalizeOllamaModelName} from '../../../services/ollama';
import {getLocalWhisperMetadata} from '../../../services/localSpeechModels';
import {GOOGLE_TRANSCRIBE_MODELS, OPENAI_TRANSCRIBE_MODELS, GEMINI_LLM_MODELS, OPENAI_LLM_MODELS} from '@shared/constants';

const OPENAI_TRANSCRIBE_SET = new Set<string>(OPENAI_TRANSCRIBE_MODELS as readonly string[]);
const GOOGLE_TRANSCRIBE_SET = new Set<string>(GOOGLE_TRANSCRIBE_MODELS as readonly string[]);
const OPENAI_LLM_SET = new Set<string>(OPENAI_LLM_MODELS as readonly string[]);
const GEMINI_LLM_SET = new Set<string>(GEMINI_LLM_MODELS as readonly string[]);

const toTitle = (value: string): string =>
    value
        .replace(/[:]/g, ' ')
        .replace(/-/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');

export const formatTranscribeLabel = (value: string): string => {
    const metadata = getLocalWhisperMetadata(value);
    if (metadata) {
        return `${metadata.label} (${metadata.size})`;
    }
    if (GOOGLE_TRANSCRIBE_SET.has(value)) {
        return `Google ${toTitle(value)}`;
    }
    if (OPENAI_TRANSCRIBE_SET.has(value)) {
        return `OpenAI ${toTitle(value)}`;
    }
    return toTitle(value);
};

export const formatLlmLabel = (value: string): string => {
    if (GEMINI_LLM_SET.has(value)) {
        return `Google ${toTitle(value)}`;
    }
    if (OPENAI_LLM_SET.has(value)) {
        return `OpenAI ${toTitle(value)}`;
    }
    const normalized = normalizeOllamaModelName(value);
    const size = LOCAL_LLM_SIZE_HINTS[normalized];
    return size ? `${toTitle(value)} - ${size}` : toTitle(value);
};
