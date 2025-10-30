import { useEffect, useMemo, useState } from 'react';
import { useSettingsContext } from '../SettingsView/SettingsView';
import { logger } from '../../../utils/logger';
import { HolderAccess } from '../HolderAccess/HolderAccess';
import { SettingsToast } from '../shared/SettingsToast/SettingsToast';
import './GeneralSettings.scss';

const MIN_WINDOW_WIDTH = 400;
const MIN_WINDOW_HEIGHT = 500;

type Message = { text: string; tone: 'success' | 'error' };

export const GeneralSettings = () => {
    const { settings, patchLocal } = useSettingsContext();
    const [openaiKey, setOpenaiKey] = useState(settings.openaiApiKey ?? '');
    const [googleKey, setGoogleKey] = useState(settings.googleApiKey ?? '');
    const [windowOpacity, setWindowOpacity] = useState(settings.windowOpacity ?? 100);
    const [windowScale, setWindowScale] = useState(settings.windowScale ?? 1);
    const [windowWidth, setWindowWidth] = useState(settings.windowWidth ?? 420);
    const [windowHeight, setWindowHeight] = useState(settings.windowHeight ?? 780);
    const [message, setMessage] = useState<Message | null>(null);

    const restartNoteVisible = useMemo(() => {
        const initial = settings.windowScale ?? 1;
        return Math.abs(initial - windowScale) > 1e-3;
    }, [settings.windowScale, windowScale]);

    useEffect(() => {
        setOpenaiKey(settings.openaiApiKey ?? '');
        setGoogleKey(settings.googleApiKey ?? '');
        setWindowOpacity(settings.windowOpacity ?? 100);
        setWindowScale(settings.windowScale ?? 1);
        setWindowWidth(settings.windowWidth ?? 420);
        setWindowHeight(settings.windowHeight ?? 780);
    }, [settings]);

    const showMessage = (text: string, tone: Message['tone'] = 'success') => {
        setMessage({ text, tone });
        setTimeout(() => {
            setMessage((current) => (current?.text === text ? null : current));
        }, 3000);
    };

    const handleSaveOpenAi = async () => {
        const key = openaiKey.trim();
        if (!key) {
            showMessage('OpenAI API key cannot be empty', 'error');
            return;
        }
        try {
            await window.api.settings.setOpenaiApiKey(key);
            patchLocal({ openaiApiKey: key });
            logger.info('settings', 'OpenAI API key saved');
            showMessage('OpenAI API key saved');
        } catch (error) {
            logger.error('settings', 'Failed to save OpenAI API key', { error });
            showMessage('Failed to save OpenAI key', 'error');
        }
    };

    const handleSaveGoogle = async () => {
        const key = googleKey.trim();
        if (!key) {
            showMessage('Google API key cannot be empty', 'error');
            return;
        }
        try {
            await window.api.settings.setGoogleApiKey(key);
            patchLocal({ googleApiKey: key });
            logger.info('settings', 'Google API key saved');
            showMessage('Google API key saved');
        } catch (error) {
            logger.error('settings', 'Failed to save Google API key', { error });
            showMessage('Failed to save Google key', 'error');
        }
    };

    const toggleAlwaysOnTop = async (value: boolean) => {
        try {
            await window.api.settings.setAlwaysOnTop(value);
            patchLocal({ alwaysOnTop: value });
            showMessage(`Always on top ${value ? 'enabled' : 'disabled'}`);
        } catch (error) {
            logger.error('settings', 'Failed to update always on top', { error });
            showMessage('Failed to update always on top', 'error');
        }
    };

    const toggleHideApp = async (value: boolean) => {
        try {
            await window.api.settings.setHideApp(value);
            patchLocal({ hideApp: value });
            showMessage(`Hide app ${value ? 'enabled' : 'disabled'}`);
        } catch (error) {
            logger.error('settings', 'Failed to update hide app', { error });
            showMessage('Failed to update hide app', 'error');
        }
    };

    const updateOpacity = async (value: number) => {
        setWindowOpacity(value);
        try {
            await window.api.settings.setWindowOpacity(value);
            patchLocal({ windowOpacity: value });
        } catch (error) {
            logger.error('settings', 'Failed to update window opacity', { error });
        }
    };

    const updateScale = async (value: number) => {
        setWindowScale(value);
        try {
            await window.api.settings.setWindowScale(value);
            patchLocal({ windowScale: value });
        } catch (error) {
            logger.error('settings', 'Failed to update window scale', { error });
            showMessage('Failed to update window scale', 'error');
        }
    };

    const saveWindowSize = async () => {
        const width = Math.max(MIN_WINDOW_WIDTH, Math.round(windowWidth));
        const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(windowHeight));
        setWindowWidth(width);
        setWindowHeight(height);
        try {
            await window.api.settings.setWindowSize({ width, height });
            patchLocal({ windowWidth: width, windowHeight: height });
            showMessage('Window size saved');
        } catch (error) {
            logger.error('settings', 'Failed to save window size', { error });
            showMessage('Failed to save window size', 'error');
        }
    };

    const openConfigFolder = async () => {
        try {
            await window.api.settings.openConfigFolder();
        } catch (error) {
            logger.error('settings', 'Failed to open config folder', { error });
            showMessage('Unable to open config folder', 'error');
        }
    };

    return (
        <div className="settings-sections">
            <SettingsToast message={message} />

            <section className="settings-card card">
                <h3 className="settings-card__title">API Keys</h3>
                <div className="settings-grid">
                    <div className="settings-field">
                        <label className="settings-field__label">OpenAI</label>
                        <input
                            type="password"
                            className="input-field"
                            value={openaiKey}
                            placeholder="Enter your OpenAI API key"
                            onChange={(event) => setOpenaiKey(event.target.value)}
                        />
                        <button type="button" className="btn btn-sm" onClick={handleSaveOpenAi}>
                            Save
                        </button>
                    </div>
                    <div className="settings-field">
                        <label className="settings-field__label">Google AI</label>
                        <input
                            type="password"
                            className="input-field"
                            value={googleKey}
                            placeholder="Enter your Google API key"
                            onChange={(event) => setGoogleKey(event.target.value)}
                        />
                        <button type="button" className="btn btn-sm" onClick={handleSaveGoogle}>
                            Save
                        </button>
                    </div>
                </div>
            </section>

            <HolderAccess />

            <section className="settings-card card">
                <h3 className="settings-card__title">Window Behaviour</h3>
                <div className="settings-toggle">
                    <label className="settings-toggle__label">
                        <input
                            type="checkbox"
                            checked={Boolean(settings.alwaysOnTop)}
                            onChange={(event) => toggleAlwaysOnTop(event.target.checked)}
                        />
                        Always on top
                    </label>
                    <label className="settings-toggle__label">
                        <input
                            type="checkbox"
                            checked={Boolean(settings.hideApp)}
                            onChange={(event) => toggleHideApp(event.target.checked)}
                        />
                        Hide app from screen recording
                    </label>
                </div>

                <div className="settings-slider">
                    <span className="settings-slider__label">Window opacity</span>
                    <div className="settings-slider__control">
                        <input
                            type="range"
                            min={5}
                            max={100}
                            value={windowOpacity}
                            className="settings-range"
                            onChange={(event) => updateOpacity(Number(event.target.value))}
                        />
                        <span className="settings-slider__value">{windowOpacity}%</span>
                    </div>
                </div>

                <div className="settings-slider">
                    <span className="settings-slider__label">Window scale</span>
                    <div className="settings-slider__control">
                        <input
                            type="range"
                            min={0.5}
                            max={3}
                            step={0.1}
                            value={windowScale}
                            className="settings-range"
                            onChange={(event) => updateScale(Number(event.target.value))}
                        />
                        <span className="settings-slider__value">{windowScale.toFixed(1)}x</span>
                    </div>
                </div>
                {restartNoteVisible ? (
                    <div className="settings-note">
                        ⚠️ Changing the scale requires restarting the application
                    </div>
                ) : null}
            </section>

            <section className="settings-card card">
                <h3 className="settings-card__title">Window size on startup</h3>
                <div className="settings-window-size">
                    <div className="settings-field">
                        <label className="settings-field__label">Width (min {MIN_WINDOW_WIDTH})</label>
                        <input
                            type="number"
                            className="input-field"
                            min={MIN_WINDOW_WIDTH}
                            value={windowWidth}
                            onChange={(event) => setWindowWidth(Number(event.target.value))}
                        />
                    </div>
                    <div className="settings-field">
                        <label className="settings-field__label">Height (min {MIN_WINDOW_HEIGHT})</label>
                        <input
                            type="number"
                            className="input-field"
                            min={MIN_WINDOW_HEIGHT}
                            value={windowHeight}
                            onChange={(event) => setWindowHeight(Number(event.target.value))}
                        />
                    </div>
                </div>
                <button type="button" className="btn btn-sm" onClick={saveWindowSize}>
                    Save
                </button>
            </section>

            <section className="settings-card card">
            <h3 className="settings-card__title">Config folder</h3>
                <button type="button" className="btn btn-sm" onClick={openConfigFolder}>
                    Open config folder
                </button>
            </section>
        </div>
    );
};
