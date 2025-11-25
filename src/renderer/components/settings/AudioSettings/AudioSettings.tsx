import { useEffect, useState } from 'react';
import {TextField, MenuItem} from '@mui/material';
import { toast } from 'react-toastify';
import { useSettingsContext } from '../SettingsView/SettingsView';
import type { AudioDevice } from '../../../types';
import { logger } from '../../../utils/logger';
import { emitSettingsChange } from '../../../utils/settingsEvents';
import './AudioSettings.scss';

const AUDIO_INPUT_TYPES: { value: 'microphone' | 'system'; label: string }[] = [
    { value: 'microphone', label: 'Microphone' },
    { value: 'system', label: 'System audio' },
];

type MessageTone = 'success' | 'error';

export const AudioSettings = () => {
    const { settings, patchLocal } = useSettingsContext();
    const [devices, setDevices] = useState<AudioDevice[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        void loadDevices();
    }, []);

    const showMessage = (text: string, tone: MessageTone = 'success') => {
        toast[tone](text);
    };

    const loadDevices = async () => {
        setLoading(true);
        try {
            const list = await window.api.settings.getAudioDevices();
            setDevices(list);
        } catch (error) {
            logger.error('settings', 'Failed to load audio devices', { error });
            setDevices([]);
            showMessage('Failed to load audio devices', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleInputTypeChange = async (type: 'microphone' | 'system') => {
        try {
            await window.api.settings.setAudioInputType(type);
            patchLocal({ audioInputType: type });
            emitSettingsChange('audioInputType', type);
            showMessage(`Audio input switched to ${type}`);
        } catch (error) {
            logger.error('settings', 'Failed to set audio input type', { error });
            showMessage('Failed to update audio input type', 'error');
        }
    };

    const handleDeviceChange = async (deviceId: string) => {
        try {
            await window.api.settings.setAudioInputDevice(deviceId);
            patchLocal({ audioInputDeviceId: deviceId });
            showMessage('Audio input device saved');
        } catch (error) {
            logger.error('settings', 'Failed to set audio input device', { error });
            showMessage('Failed to update audio input device', 'error');
        }
    };

    const currentDeviceId = settings.audioInputDeviceId ?? '';

    return (
        <div className="audio-settings">
            <section className="settings-card card">
                <h3 className="settings-card__title">Audio input</h3>
                <div className="settings-field">
                    <TextField
                        select
                        size="small"
                        label="Input type"
                        value={settings.audioInputType ?? 'microphone'}
                        onChange={(event) => handleInputTypeChange(event.target.value as 'microphone' | 'system')}
                        fullWidth
                    >
                        {AUDIO_INPUT_TYPES.map((option) => (
                            <MenuItem key={option.value} value={option.value}>
                                {option.label}
                            </MenuItem>
                        ))}
                    </TextField>
                </div>

                <div className="settings-field">
                    <TextField
                        select
                        size="small"
                        label="Device"
                        value={currentDeviceId}
                        onChange={(event) => handleDeviceChange(event.target.value)}
                        fullWidth
                        disabled={settings.audioInputType === 'system'}
                    >
                        {[{ value: '', label: 'Default device' }, ...devices.map((device) => ({ value: device.deviceId, label: device.label }))].map(
                            (option) => (
                                <MenuItem key={option.value} value={option.value}>
                                    {option.label}
                                </MenuItem>
                            )
                        )}
                    </TextField>
                    <div className="audio-settings__actions">
                        <button type="button" className="btn btn-sm" onClick={loadDevices} disabled={loading}>
                            Refresh devices
                        </button>
                    </div>
                </div>
            </section>
        </div>
    );
};
