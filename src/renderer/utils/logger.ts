// Simple logger for the renderer process
// Sends logs to the main process via IPC

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export type LogEntry = {
    timestamp: string;
    level: LogLevel;
    category: string;
    message: string;
    data?: any;
};

const OPENAI_CREDENTIAL_PATTERN =
    /(^|[^A-Za-z0-9_-])((?:sk-(?:proj-|svcacct-)?|ek[_-])(?=[A-Za-z0-9_-]{20,}(?:[^A-Za-z0-9_-]|$))(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+)(?=$|[^A-Za-z0-9_-])/g;

/**
 * Redacts plausible OpenAI API keys and short-lived Realtime client secrets
 * even when they appear in an otherwise non-sensitive string (for example a
 * WebSocket protocol error). The length and character-class checks keep short
 * identifiers such as `sk-test` or `ek_value` readable in ordinary logs.
 */
export function redactOpenAiCredentials(value: string): string {
    return value.replace(OPENAI_CREDENTIAL_PATTERN, '$1[redacted OpenAI credential]');
}

class RendererLogger {
    private sanitize(data: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
        if (data == null || typeof data === 'number' || typeof data === 'boolean') return data;
        if (typeof data === 'string') {
            const redacted = redactOpenAiCredentials(data);
            return redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}…` : redacted;
        }
        if (typeof data !== 'object') return String(data);
        if (depth >= 5) return '[truncated]';
        if (seen.has(data)) return '[circular]';
        seen.add(data);

        if (data instanceof Error) {
            return {
                name: redactOpenAiCredentials(data.name).slice(0, 200),
                message: redactOpenAiCredentials(data.message).slice(0, 1_000),
            };
        }
        if (Array.isArray(data)) {
            return data.slice(0, 50).map((item) => this.sanitize(item, depth + 1, seen));
        }

        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            const normalized = key.toLowerCase();
            if (/(api.?key|authorization|cookie|password|secret|token|credential)/i.test(normalized)) {
                result[key] = '[redacted credential]';
                continue;
            }
            result[key] = this.sanitize(value, depth + 1, seen);
        }
        return result;
    }

    private log(level: LogLevel, category: string, message: string, data?: any): void {
        const sanitizedCategory = redactOpenAiCredentials(category);
        const sanitizedMessage = redactOpenAiCredentials(message);
        const sanitizedData = this.sanitize(data);
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            category: sanitizedCategory,
            message: sanitizedMessage,
            data: sanitizedData,
        };

        // Send to the main process via IPC
        const hasBridgeLogger = Boolean(window.api?.log);
        if (hasBridgeLogger) {
            void window.api.log(entry);
        }

        // Also print to console during development
        if (!hasBridgeLogger) {
            const consoleMethod = level === 'error' ? console.error :
                level === 'warn' ? console.warn :
                    level === 'debug' ? console.debug : console.log;

            consoleMethod(`[${sanitizedCategory}] ${sanitizedMessage}`, sanitizedData || '');
        }
    }

    public info(category: string, message: string, data?: any): void {
        this.log('info', category, message, data);
    }

    public warn(category: string, message: string, data?: any): void {
        this.log('warn', category, message, data);
    }

    public error(category: string, message: string, data?: any): void {
        this.log('error', category, message, data);
    }

    public debug(category: string, message: string, data?: any): void {
        this.log('debug', category, message, data);
    }
}

export const logger = new RendererLogger();
