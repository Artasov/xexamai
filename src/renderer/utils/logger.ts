// Простой логгер для renderer процесса
// Отправляет логи в main процесс через IPC

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

        // Отправляем в main процесс через IPC
        const hasBridgeLogger = Boolean(window.api?.log);
        if (hasBridgeLogger) {
            window.api.log(entry);
        }

        // Также выводим в консоль для разработки
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
