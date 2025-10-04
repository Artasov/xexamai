import {app} from 'electron';
import fs from 'node:fs';
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

    constructor() {
        const userDataPath = app.getPath('userData');
        this.logDir = path.join(userDataPath, 'xexamai', 'logs');
        
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, {recursive: true});
        }

        this.logFile = path.join(this.logDir, 'latest.log');
        this.clearLogOnStartup();
        this.rotateLogIfNeeded();
    }

    private clearLogOnStartup(): void {
        try {
            if (fs.existsSync(this.logFile)) {
                fs.writeFileSync(this.logFile, '', 'utf8');
                console.log(`[logger] Cleared log file: ${this.logFile}`);
            }
        } catch (error) {
            console.error('Failed to clear log file:', error);
        }
    }

    private rotateLogIfNeeded(): void {
        if (!fs.existsSync(this.logFile)) return;

        const stats = fs.statSync(this.logFile);
        if (stats.size >= this.maxLogSize) {
            // Ротируем логи
            for (let i = this.maxLogFiles - 1; i > 0; i--) {
                const oldFile = path.join(this.logDir, `latest.${i}.log`);
                const newFile = path.join(this.logDir, `latest.${i + 1}.log`);
                
                if (fs.existsSync(oldFile)) {
                    if (i === this.maxLogFiles - 1) {
                        fs.unlinkSync(oldFile);
                    } else {
                        fs.renameSync(oldFile, newFile);
                    }
                }
            }

            // Переименовываем текущий файл
            const rotatedFile = path.join(this.logDir, 'latest.1.log');
            fs.renameSync(this.logFile, rotatedFile);
        }
    }

    private formatLogEntry(entry: LogEntry): string {
        const dataStr = entry.data ? ` | ${JSON.stringify(entry.data)}` : '';
        return `[${entry.timestamp}] ${entry.level.toUpperCase()} | ${entry.category} | ${entry.message}${dataStr}\n`;
    }

    private writeLog(entry: LogEntry): void {
        try {
            const logLine = this.formatLogEntry(entry);
            fs.appendFileSync(this.logFile, logLine, 'utf8');
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

        this.writeLog(entry);
        
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
