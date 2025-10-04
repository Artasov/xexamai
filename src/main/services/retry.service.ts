export interface RetryConfig {
    maxAttempts: number;
    baseDelay: number; // в миллисекундах
    maxDelay: number; // в миллисекундах
    backoffMultiplier: number;
    jitter: boolean;
}

export const DefaultRetryConfig: RetryConfig = {
    maxAttempts: 3,
    baseDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
    jitter: true,
};

export interface RetryableError extends Error {
    isRetryable: boolean;
    statusCode?: number;
}

export function isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
        const message = error.message.toLowerCase();

        if (message.includes('connection') ||
            message.includes('timeout') ||
            message.includes('network') ||
            message.includes('econnreset') ||
            message.includes('enotfound') ||
            message.includes('etimedout')) {
            return true;
        }

        if ('status' in error && typeof error.status === 'number') {
            const status = error.status as number;
            return status >= 500 || status === 429;
        }

        if (message.includes('rate limit') ||
            message.includes('server error') ||
            message.includes('internal server error')) {
            return true;
        }
    }

    return false;
}

export function createRetryableError(message: string, statusCode?: number): RetryableError {
    const error = new Error(message) as RetryableError;
    error.isRetryable = true;
    error.statusCode = statusCode;
    return error;
}

export async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function calculateDelay(attempt: number, config: RetryConfig): number {
    let delay = config.baseDelay * Math.pow(config.backoffMultiplier, attempt - 1);

    delay = Math.min(delay, config.maxDelay);

    if (config.jitter) {
        const jitterAmount = delay * 0.1;
        delay += (Math.random() - 0.5) * 2 * jitterAmount;
    }

    return Math.max(0, delay);
}

export async function withRetry<T>(
    operation: () => Promise<T>,
    config: RetryConfig = DefaultRetryConfig,
    operationName: string = 'operation',
    timeoutMs?: number
): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
        try {
            if (timeoutMs && timeoutMs > 0) {
                return await Promise.race([
                    operation(),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs)
                    )
                ]);
            } else {
                return await operation();
            }
        } catch (error) {
            lastError = error as Error;

            if (attempt === config.maxAttempts || !isRetryableError(error)) {
                throw error;
            }

            const delay = calculateDelay(attempt, config);

            console.warn(
                `${operationName} failed (attempt ${attempt}/${config.maxAttempts}): ${error}. Retrying in ${delay}ms...`
            );

            await sleep(delay);
        }
    }

    throw lastError || new Error(`${operationName} failed after ${config.maxAttempts} attempts`);
}

export class RetryService {
    private config: RetryConfig;

    constructor(config: RetryConfig = DefaultRetryConfig) {
        this.config = config;
    }

    async execute<T>(
        operation: () => Promise<T>,
        operationName: string = 'operation',
        timeoutMs?: number
    ): Promise<T> {
        return withRetry(operation, this.config, operationName, timeoutMs);
    }

    updateConfig(newConfig: Partial<RetryConfig>): void {
        this.config = {...this.config, ...newConfig};
    }

    getConfig(): RetryConfig {
        return {...this.config};
    }
}
