type SettingsEventKey = 'streamMode' | 'streamSendHotkey' | 'audioInputType' | 'durations' | 'durationHotkeys';

export function emitSettingsChange(key: SettingsEventKey, value: unknown) {
    window.dispatchEvent(new CustomEvent('xexamai:settings-changed', {
        detail: { key, value },
    }));
}
