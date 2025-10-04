import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { RetryConfig, DefaultRetryConfig } from './retry.service';
import { appConfigService } from './app-config.service';

export type AppConfig = {
    openaiApiKey: string | undefined;
    openaiBaseUrl?: string;
    transcriptionModel: string;
    chatModel: string;
    retryConfig: RetryConfig;
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
        transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1',
        chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4.1-nano',
        retryConfig,
    };
}

export function updateApiKeyFromSettings(apiKey?: string): void {
}

