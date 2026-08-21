// noinspection JSUnusedGlobalSymbols

import {toast} from 'react-toastify';
import type {AppSettings} from '@shared/ipc';

export const requireKey = (key: 'openai' | 'google') => {
    return (settings: AppSettings): boolean => {
        const has = key === 'openai'
            ? settings.hasOpenaiApiKey === true
            : settings.hasGoogleApiKey === true;
        if (!has) {
            toast.error(key === 'openai' ? 'Add an OpenAI API key first' : 'Add a Google API key first');
        }
        return has;
    };
};

export const requireOpenAiKey = requireKey('openai');
export const requireGoogleKey = requireKey('google');
