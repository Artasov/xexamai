import {toast} from 'react-toastify';
import type {AppSettings} from '@shared/ipc';

export const requireKey = (key: 'openai' | 'google') => {
    return (settings: AppSettings): boolean => {
        const value = key === 'openai' ? settings.openaiApiKey : settings.googleApiKey;
        const has = Boolean(value && value.trim().length > 0);
        if (!has) {
            toast.error(key === 'openai' ? 'Add an OpenAI API key first' : 'Add a Google API key first');
        }
        return has;
    };
};

export const requireOpenAiKey = requireKey('openai');
export const requireGoogleKey = requireKey('google');
