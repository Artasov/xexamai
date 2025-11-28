import {logger} from '../utils/logger';

export const MAX_LOG_PREVIEW_LENGTH = 400;

export const previewText = (text: string | undefined, maxLength: number = MAX_LOG_PREVIEW_LENGTH): string => {
    const normalized = (text ?? '').toString();
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}… (${normalized.length} chars)`;
};

export const buildLogPayload = (details: Record<string, unknown> = {}) => {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
        if (typeof value === 'string') {
            payload[key] = previewText(value);
        } else if (Array.isArray(value)) {
            payload[key] = value.length > 10 ? [...value.slice(0, 10), `…(${value.length - 10} more)`] : value;
        } else {
            payload[key] = value;
        }
    }
    return payload;
};

export const logRequest = (
    label: string,
    status: 'start' | 'ok' | 'error',
    details: Record<string, unknown> = {}
) => {
    const payload = buildLogPayload(details);
    const message = `${label}: ${status}`;
    if (status === 'error') {
        logger.error('network', message, payload);
        return;
    }
    logger.info('network', message, payload);
};
