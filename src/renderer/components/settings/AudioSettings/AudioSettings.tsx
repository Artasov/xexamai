// noinspection XmlDeprecatedElement

import {useEffect, useState} from 'react';
import {MenuItem, TextField} from '@mui/material';
import {toast} from 'react-toastify';
import {useSettingsContext} from '../SettingsView/SettingsView';
import type {AudioDeviceInfo} from '@shared/ipc';
import {logger} from '../../../utils/logger';
import {requestSettingsChange} from '../../../utils/settingsEvents';
import {
    migrateLegacyAudioDeviceSelection,
} from '../../../app/audioSession/deviceSelection';
import './AudioSettings.scss';

const AUDIO_INPUT_TYPES: { value: 'microphone' | 'system' | 'mixed'; label: string }[] = [
    {value: 'microphone', label: 'Microphone'},
    {value: 'system', label: 'System audio'},
    {value: 'mixed', label: 'Mic + System'},
];

type MessageTone = 'success' | 'error';

export const AudioSettings = () => {
    const {settings, patchLocal} = useSettingsContext();
    const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [inputSwitching, setInputSwitching] = useState(false);

    useEffect(() => {
        void loadDevices();
    }, []);

    const showMessage = (text: string, tone: MessageTone = 'success') => {
        if (tone === 'success') return;
        toast[tone](text);
    };

    const loadDevices = async () => {
        setLoading(true);
        try {
            const list = await window.api.audio.listDevices();
            setDevices(list);
            const saved = settings.audioInputDeviceId ?? '';
            const migratedId = await migrateLegacyAudioDeviceSelection(list, saved);
            if (migratedId !== saved) {
                patchLocal({audioInputDeviceId: migratedId});
            }
        } catch (error) {
            logger.error('settings', 'Failed to load audio devices', {error});
            setDevices([]);
            showMessage('Failed to load audio devices', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleInputTypeChange = async (type: 'microphone' | 'system' | 'mixed') => {
        const previous = settings.audioInputType ?? 'microphone';
        patchLocal({audioInputType: type});
        setInputSwitching(true);
        try {
            const result = await requestSettingsChange('audioInputType', type);
            const applied = result.appliedValue === 'system' || result.appliedValue === 'mixed'
                ? result.appliedValue
                : result.appliedValue === 'microphone'
                    ? 'microphone'
                    : previous;
            patchLocal({audioInputType: applied});
            if (!result.success) showMessage(result.error || 'Failed to switch audio input', 'error');
        } catch (error) {
            patchLocal({audioInputType: previous});
            logger.error('settings', 'Failed to set audio input type', {error});
            showMessage('Failed to update audio input type', 'error');
        } finally {
            setInputSwitching(false);
        }
    };

    const handleDeviceChange = async (deviceId: string) => {
        const previous = settings.audioInputDeviceId ?? '';
        setInputSwitching(true);
        try {
            const result = await requestSettingsChange('audioInputDeviceId', deviceId);
            const applied = typeof result.appliedValue === 'string' ? result.appliedValue : previous;
            patchLocal({audioInputDeviceId: applied});
            if (!result.success) showMessage(result.error || 'Failed to switch microphone', 'error');
        } catch (error) {
            patchLocal({audioInputDeviceId: previous});
            logger.error('settings', 'Failed to set audio input device', {error});
            showMessage('Failed to update audio input device', 'error');
        } finally {
            setInputSwitching(false);
        }
    };

    const currentDeviceId = settings.audioInputDeviceId ?? '';
    const selectedUnavailable = currentDeviceId && !devices.some((device) => device.id === currentDeviceId);
    const deviceOptions = [
        {value: '', label: 'Default device'},
        ...(selectedUnavailable ? [{value: currentDeviceId, label: `Unavailable: ${currentDeviceId}`}] : []),
        ...devices.map((device) => ({
        value: device.id,
        label: device.name
        })),
    ];
    const renderDeviceLabel = (value: string) => {
        if (!value) return 'Default device';
        return deviceOptions.find((option) => option.value === value)?.label ?? `Unavailable: ${value}`;
    };

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
                        onChange={(event) => handleInputTypeChange(event.target.value as 'microphone' | 'system' | 'mixed')}
                        disabled={inputSwitching}
                        fullWidth
                    >
                        {AUDIO_INPUT_TYPES.map((option) => (
                            <MenuItem key={option.value} value={option.value}>
                                {option.label}
                            </MenuItem>
                        ))}
                    </TextField>
                </div>

                {settings.audioInputType === 'system' ? null : (
                    <div className="settings-field">
                        <TextField
                            select
                            size="small"
                            label="Device"
                            value={currentDeviceId}
                            onChange={(event) => handleDeviceChange(event.target.value)}
                            disabled={inputSwitching}
                            fullWidth
                            slotProps={{
                                select: {
                                    displayEmpty: true,
                                    renderValue: (value) => renderDeviceLabel((value as string) ?? ''),
                                },
                                inputLabel: {shrink: true},
                            }}
                        >
                            {deviceOptions.map((option) => (
                                <MenuItem key={option.value} value={option.value}>
                                    {option.label}
                                </MenuItem>
                            ))}
                        </TextField>
                        <div className="audio-settings__actions">
                            <button type="button" className="btn btn-sm" onClick={loadDevices} disabled={loading}>
                                Refresh devices
                            </button>
                        </div>
                    </div>
                )}
            </section>
        </div>
    );
};
