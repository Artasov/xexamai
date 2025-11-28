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

class RendererLogger {
    private log(level: LogLevel, category: string, message: string, data?: any): void {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            category,
            message,
            data
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

            consoleMethod(`[${category}] ${message}`, data || '');
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
