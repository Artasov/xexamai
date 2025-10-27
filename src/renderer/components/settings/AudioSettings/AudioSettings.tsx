import { useEffect, useState } from 'react';
import { useSettingsContext } from '../SettingsView/SettingsView';
import type { AudioDevice } from '../../../types';
import { logger } from '../../../utils/logger';
import { emitSettingsChange } from '../../../utils/settingsEvents';
import CustomSelect from '../../common/CustomSelect/CustomSelect';
import { SettingsToast } from '../shared/SettingsToast/SettingsToast';
import './AudioSettings.scss';

const AUDIO_INPUT_TYPES: { value: 'microphone' | 'system'; label: string }[] = [
    { value: 'microphone', label: 'Microphone' },
    { value: 'system', label: 'System audio' },
];

type MessageTone = 'success' | 'error';
type Message = { text: string; tone: MessageTone } | null;

export const AudioSettings = () => {
    const { settings, patchLocal } = useSettingsContext();
    const [devices, setDevices] = useState<AudioDevice[]>([]);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState<Message>(null);

    useEffect(() => {
        void loadDevices();
    }, []);

    const showMessage = (text: string, tone: MessageTone = 'success') => {
        setMessage({ text, tone });
        setTimeout(() => {
            setMessage((prev) => (prev?.text === text ? null : prev));
        }, 2800);
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
            <SettingsToast message={message} />

            <section className="settings-card card">
                <h3 className="settings-card__title">Audio input</h3>
                <div className="settings-field">
                    <label className="settings-field__label">Input type</label>
                    <CustomSelect
                        value={settings.audioInputType ?? 'microphone'}
                        options={AUDIO_INPUT_TYPES}
                        onChange={(val) => handleInputTypeChange(val as 'microphone' | 'system')}
                    />
                </div>

                <div className="settings-field">
                    <label className="settings-field__label">Device</label>
                    <CustomSelect
                        value={currentDeviceId}
                        options={[{ value: '', label: 'Default device' }, ...devices.map((device) => ({ value: device.deviceId, label: device.label }))]}
                        disabled={settings.audioInputType === 'system'}
                        onChange={handleDeviceChange}
                    />
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
