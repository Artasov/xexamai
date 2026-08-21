export type SettingsEventKey =
    | 'streamSendHotkey'
    | 'audioInputType'
    | 'audioInputDeviceId'
    | 'transcriptionMode'
    | 'transcriptionModel'
    | 'durations'
    | 'durationHotkeys';

export type SettingsChangeResult = {
    success: boolean;
    appliedValue: unknown;
    error?: string;
};

export type SettingsChangeDetail = {
    key: SettingsEventKey;
    value: unknown;
    handled?: boolean;
    complete?: (result: SettingsChangeResult) => void;
};

export function emitSettingsChange(key: SettingsEventKey, value: unknown) {
    window.dispatchEvent(new CustomEvent('xexamai:settings-changed', {
        detail: {key, value},
    }));
}

/** Request an applied setting and receive the actual value after rollback. */
export function requestSettingsChange(key: SettingsEventKey, value: unknown): Promise<SettingsChangeResult> {
    return new Promise((resolve) => {
        const detail: SettingsChangeDetail = {key, value, complete: resolve};
        window.dispatchEvent(new CustomEvent('xexamai:settings-changed', {detail}));
        if (!detail.handled) {
            resolve({success: false, appliedValue: undefined, error: 'Settings controller is not ready'});
        }
    });
}
