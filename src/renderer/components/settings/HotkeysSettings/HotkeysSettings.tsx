import { useMemo, useState } from 'react';
import { useSettingsContext } from '../SettingsView/SettingsView';
import { logger } from '../../../utils/logger';
import { emitSettingsChange } from '../../../utils/settingsEvents';
import { SettingsToast } from '../shared/SettingsToast/SettingsToast';
import './HotkeysSettings.scss';

type MessageTone = 'success' | 'error';
type Message = { text: string; tone: MessageTone } | null;

const clampDuration = (duration: number) => Math.max(1, Math.min(300, duration));

export const HotkeysSettings = () => {
    const { settings, patchLocal } = useSettingsContext();
    const [newDuration, setNewDuration] = useState('');
    const [durationHotkeys, setDurationHotkeys] = useState<Record<number, string>>(settings.durationHotkeys ?? {});
    const [toggleHotkey, setToggleHotkey] = useState(settings.toggleInputHotkey ?? 'g');
    const [streamSendHotkey, setStreamSendHotkey] = useState(settings.streamSendHotkey ?? '~');
    const [message, setMessage] = useState<Message>(null);

    const durations = useMemo(() => [...(settings.durations ?? [])].sort((a, b) => a - b), [settings.durations]);

    const showMessage = (text: string, tone: MessageTone = 'success') => {
        setMessage({ text, tone });
        setTimeout(() => {
            setMessage((prev) => (prev?.text === text ? null : prev));
        }, 2600);
    };

    const updateDurations = async (next: number[]) => {
        try {
            await window.api.settings.setDurations(next);
            patchLocal({ durations: next });
            emitSettingsChange('durations', next);
            showMessage('Durations saved');
        } catch (error) {
            logger.error('settings', 'Failed to save durations', { error });
            showMessage('Failed to save durations', 'error');
        }
    };

    const addDuration = async () => {
        const raw = Number(newDuration);
        if (Number.isNaN(raw)) {
            showMessage('Invalid duration', 'error');
            return;
        }
        const duration = clampDuration(Math.round(raw));
        if (durations.includes(duration)) {
            showMessage('Duration already exists', 'error');
            return;
        }
        const next = [...durations, duration].sort((a, b) => a - b);
        await updateDurations(next);
        setNewDuration('');
    };

    const removeDuration = async (duration: number) => {
        const next = durations.filter((value) => value !== duration);
        await updateDurations(next);
        const hotkeys = { ...durationHotkeys };
        delete hotkeys[duration];
        setDurationHotkeys(hotkeys);
        await saveDurationHotkeys(hotkeys, false);
    };

    const saveDurationHotkeys = async (map: Record<number, string>, toast = true) => {
        try {
            await (window.api.settings as any).setDurationHotkeys(map);
            patchLocal({ durationHotkeys: map });
            emitSettingsChange('durationHotkeys', map);
            if (toast) {
                showMessage('Duration hotkeys saved');
            }
        } catch (error) {
            logger.error('settings', 'Failed to save duration hotkeys', { error });
            if (toast) {
                showMessage('Failed to save duration hotkeys', 'error');
            }
        }
    };

    const saveHotkeyForDuration = async (duration: number) => {
        const value = (durationHotkeys[duration] ?? '').trim();
        if (!value) {
            showMessage('Hotkey cannot be empty', 'error');
            return;
        }
        const char = value[0].toLowerCase();
        const map = { ...durationHotkeys, [duration]: char };
        setDurationHotkeys(map);
        await saveDurationHotkeys(map);
    };

    const saveToggleHotkey = async () => {
        const value = toggleHotkey.trim().toLowerCase();
        if (!value) {
            showMessage('Hotkey cannot be empty', 'error');
            return;
        }
        try {
            await (window.api.settings as any).setToggleInputHotkey(value);
            patchLocal({ toggleInputHotkey: value });
            showMessage('Toggle input hotkey saved');
        } catch (error) {
            logger.error('settings', 'Failed to save toggle input hotkey', { error });
            showMessage('Failed to save toggle input hotkey', 'error');
        }
    };

    const saveStreamSendHotkey = async () => {
        const value = streamSendHotkey.trim();
        if (!value) {
            showMessage('Hotkey cannot be empty', 'error');
            return;
        }
        const char = value[0];
        try {
            await (window.api.settings as any).setStreamSendHotkey(char);
            patchLocal({ streamSendHotkey: char });
            emitSettingsChange('streamSendHotkey', char);
            showMessage('Stream send hotkey saved');
        } catch (error) {
            logger.error('settings', 'Failed to save stream hotkey', { error });
            showMessage('Failed to save stream hotkey', 'error');
        }
    };

    return (
        <div className="hotkeys-settings">
            <SettingsToast message={message} />

            <section className="settings-card card">
                <h3 className="settings-card__title">Recording durations</h3>
                <div className="hotkeys-duration-list">
                    {durations.map((duration) => (
                        <div className="hotkeys-duration" key={duration}>
                            <span className="hotkeys-duration__label">{duration}s</span>
                            <input
                                className="input-field hotkeys-duration__input"
                                maxLength={1}
                                placeholder="Key"
                                value={(durationHotkeys[duration] ?? '').toUpperCase()}
                                onChange={(event) => {
                                    const value = event.target.value.slice(0, 1);
                                    setDurationHotkeys((prev) => ({ ...prev, [duration]: value.toLowerCase() }));
                                }}
                            />
                            <button type="button" className="btn btn-sm" onClick={() => saveHotkeyForDuration(duration)}>
                                Save
                            </button>
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => removeDuration(duration)}>
                                Remove
                            </button>
                        </div>
                    ))}
                </div>
                <div className="hotkeys-duration-add">
                    <input
                        type="number"
                        className="input-field"
                        placeholder="Duration in seconds"
                        value={newDuration}
                        min={1}
                        max={300}
                        onChange={(event) => setNewDuration(event.target.value)}
                    />
                    <button type="button" className="btn btn-sm" onClick={addDuration}>
                        Add duration
                    </button>
                </div>
            </section>

            <section className="settings-card card">
                <h3 className="settings-card__title">Hotkey: toggle audio input</h3>
                <div className="hotkeys-input-row">
                    <label className="hotkeys-input-row__prefix">Ctrl-</label>
                    <input
                        className="input-field hotkeys-input"
                        maxLength={1}
                        value={toggleHotkey.toUpperCase()}
                        onChange={(event) => setToggleHotkey(event.target.value.slice(0, 1).toLowerCase())}
                    />
                    <button type="button" className="btn btn-sm" onClick={saveToggleHotkey}>
                        Save
                    </button>
                </div>
                <div className="hotkeys-helper">Single letter or digit, used with Ctrl (e.g., Ctrl-G)</div>
            </section>

            <section className="settings-card card">
                <h3 className="settings-card__title">Hotkey: send from stream textarea</h3>
                <div className="hotkeys-input-row">
                    <label className="hotkeys-input-row__prefix">Ctrl-</label>
                    <input
                        className="input-field hotkeys-input"
                        maxLength={1}
                        value={streamSendHotkey}
                        onChange={(event) => setStreamSendHotkey(event.target.value.slice(0, 1))}
                    />
                    <button type="button" className="btn btn-sm" onClick={saveStreamSendHotkey}>
                        Save
                    </button>
                </div>
                <div className="hotkeys-helper">Single character for sending text from stream results.</div>
            </section>
        </div>
    );
};
