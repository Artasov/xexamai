import {app} from 'electron';
import {promises as fsp} from 'node:fs';
import path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export type LogEntry = {
    timestamp: string;
    level: LogLevel;
    category: string;
    message: string;
    data?: any;
};

export class LoggerService {
    private logDir: string;
    private logFile: string;
    private maxLogSize: number = 10 * 1024 * 1024; // 10MB
    private maxLogFiles: number = 5;
    private initPromise: Promise<void>;

    constructor() {
        const userDataPath = app.getPath('userData');
        this.logDir = path.join(userDataPath, 'xexamai', 'logs');

        this.logFile = path.join(this.logDir, 'latest.log');
        this.initPromise = this.initialize();
    }

    private async initialize(): Promise<void> {
        try {
            await fsp.mkdir(this.logDir, {recursive: true});
            await this.clearLogOnStartup();
            await this.rotateLogIfNeeded();
        } catch (error) {
            console.error('Logger initialization failed:', error);
        }
    }

    private async clearLogOnStartup(): Promise<void> {
        try {
            await fsp.writeFile(this.logFile, '', 'utf8');
            console.log(`[logger] Cleared log file: ${this.logFile}`);
        } catch (error: any) {
            if (error && error.code !== 'ENOENT') {
                console.error('Failed to clear log file:', error);
            }
        }
    }

    private async rotateLogIfNeeded(): Promise<void> {
        let stats;
        try {
            stats = await fsp.stat(this.logFile);
        } catch (error: any) {
            if (error && error.code === 'ENOENT') return;
            throw error;
        }

        if (stats.size < this.maxLogSize) return;

        for (let i = this.maxLogFiles - 1; i > 0; i--) {
            const oldFile = path.join(this.logDir, `latest.${i}.log`);
            const newFile = path.join(this.logDir, `latest.${i + 1}.log`);
            try {
                if (i === this.maxLogFiles - 1) {
                    await fsp.unlink(oldFile);
                } else {
                    await fsp.rename(oldFile, newFile);
                }
            } catch (error: any) {
                if (error && error.code !== 'ENOENT') {
                    console.error('Failed to rotate log file:', error);
                }
            }
        }

        try {
            const rotatedFile = path.join(this.logDir, 'latest.1.log');
            await fsp.rename(this.logFile, rotatedFile);
        } catch (error) {
            console.error('Failed to rotate latest log file:', error);
        }
    }

    private formatLogEntry(entry: LogEntry): string {
        const dataStr = entry.data ? ` | ${JSON.stringify(entry.data)}` : '';
        return `[${entry.timestamp}] ${entry.level.toUpperCase()} | ${entry.category} | ${entry.message}${dataStr}\n`;
    }

    private async writeLog(entry: LogEntry): Promise<void> {
        try {
            await this.initPromise;
            const logLine = this.formatLogEntry(entry);
            await fsp.appendFile(this.logFile, logLine, 'utf8');
        } catch (error) {
            console.error('Failed to write log:', error);
        }
    }

    public log(level: LogLevel, category: string, message: string, data?: any): void {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            category,
            message,
            data
        };

        this.writeLog(entry).catch(() => {});
        
        // Также выводим в консоль для разработки
        const consoleMethod = level === 'error' ? console.error : 
                             level === 'warn' ? console.warn : 
                             level === 'debug' ? console.debug : console.log;
        
        consoleMethod(`[${category}] ${message}`, data || '');
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

    public getLogDirectory(): string {
        return this.logDir;
    }

    public getLogFilePath(): string {
        return this.logFile;
    }
}

export const logger = new LoggerService();
