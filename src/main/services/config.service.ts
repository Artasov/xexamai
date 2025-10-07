import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import {RetryConfig} from './retry.service';
import {appConfigService} from './app-config.service';
import {TranscriptionMode, WhisperModel, LocalDevice, DEFAULT_LLM_PROMPT} from '../shared/types';

export type AppConfig = {
    openaiApiKey: string | undefined;
    openaiBaseUrl?: string;
    transcriptionModel: string;
    transcriptionPrompt: string;
    chatModel: string;
    llmPrompt: string;
    transcriptionMode: TranscriptionMode;
    localWhisperModel: WhisperModel;
    localDevice: LocalDevice;
    retryConfig: RetryConfig;
    apiSttTimeoutMs: number;
    apiLlmTimeoutMs: number;
    geminiApiKey: string | undefined;
};


export function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        dotenv.config({path: envPath});
    } else {
        dotenv.config();
    }
}

export function getConfig(): AppConfig {
    const retryConfig: RetryConfig = {
        maxAttempts: parseInt(process.env.RETRY_MAX_ATTEMPTS || '3', 10),
        baseDelay: parseInt(process.env.RETRY_BASE_DELAY || '1000', 10),
        maxDelay: parseInt(process.env.RETRY_MAX_DELAY || '10000', 10),
        backoffMultiplier: parseFloat(process.env.RETRY_BACKOFF_MULTIPLIER || '2'),
        jitter: process.env.RETRY_JITTER !== 'false',
    };

    const userConfig = appConfigService.getConfig();

    return {
        openaiApiKey: userConfig.openaiApiKey || process.env.OPENAI_API_KEY,
        openaiBaseUrl: process.env.OPENAI_BASE_URL,
        transcriptionModel: userConfig.transcriptionModel || process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
        transcriptionPrompt: userConfig.transcriptionPrompt !== undefined ? userConfig.transcriptionPrompt : (process.env.OPENAI_TRANSCRIPTION_PROMPT || 'This is a technical interview conducted in Russian. Please transcribe the speech in Russian, but preserve English programming and technical terms exactly as they are (e.g. Redis, Postgres, Celery, HTTP, API, and etc.).'),
        chatModel: userConfig.llmModel || process.env.OPENAI_CHAT_MODEL || 'gpt-4.1-nano',
        llmPrompt: userConfig.llmPrompt !== undefined ? userConfig.llmPrompt : (process.env.OPENAI_LLM_PROMPT || DEFAULT_LLM_PROMPT),
        transcriptionMode: userConfig.transcriptionMode || 'api',
        localWhisperModel: userConfig.localWhisperModel || 'base',
        localDevice: userConfig.localDevice || 'cpu',
        retryConfig,
        apiSttTimeoutMs: appConfigService.getApiSttTimeoutMs(),
        apiLlmTimeoutMs: appConfigService.getApiLlmTimeoutMs(),
        geminiApiKey: userConfig.geminiApiKey || process.env.GEMINI_API_KEY,
    };
}

export function updateApiKeyFromSettings(apiKey?: string): void {
}

