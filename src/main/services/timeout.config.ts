export interface TimeoutConfig {
    whisperTimeoutMs: number;
    chatgptTimeoutMs: number;
    whisperTimeoutMultiplier: number;
    whisperMinTimeoutMs: number;
    whisperMaxTimeoutMs: number;
}

export const DefaultTimeoutConfig: TimeoutConfig = {
    chatgptTimeoutMs: 10000,
    whisperTimeoutMultiplier: 2000,
    whisperMinTimeoutMs: 5000,
    whisperMaxTimeoutMs: 30000,
    whisperTimeoutMs: 10000,
};

export function calculateWhisperTimeout(audioSeconds: number, config: TimeoutConfig = DefaultTimeoutConfig): number {
    const calculatedTimeout = audioSeconds * config.whisperTimeoutMultiplier;

    return Math.max(
        config.whisperMinTimeoutMs,
        Math.min(calculatedTimeout, config.whisperMaxTimeoutMs)
    );
}

export function createTimeoutConfig(overrides: Partial<TimeoutConfig> = {}): TimeoutConfig {
    return {
        ...DefaultTimeoutConfig,
        ...overrides,
    };
}
