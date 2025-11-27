import {audioSessionState, AudioInputType} from './internalState';
import {setStatus} from '../../ui/status';
import {state as appState} from '../../state/appState';
import {startAudioCapture, stopAudioCapture} from '../../services/nativeAudio';
import {rebuildRecorderWithStream} from './recorder';

export type SwitchOptions = {};
export type SwitchAudioResult = { success: boolean; error?: string };

export async function switchAudioInput(newType: AudioInputType): Promise<SwitchAudioResult> {
    const previousType = audioSessionState.currentAudioInputType;
    audioSessionState.currentAudioInputType = newType;
    if (!appState.isRecording) {
        try {
            await window.api.settings.setAudioInputType(newType);
        } catch {
        }
        return { success: true };
    }
    try {
        try {
            await window.api.settings.setAudioInputType(newType);
        } catch {
        }
        
        // Останавливаем текущий захват
        const prevWasSystem = previousType === 'system' || previousType === 'mixed';
        const newIsSystem = newType === 'system' || newType === 'mixed';
        
        if (prevWasSystem && !newIsSystem) {
            // Переключаемся с system на mic - останавливаем только mic если был mixed
            if (previousType === 'mixed') {
                await stopAudioCapture();
            }
        } else if (!prevWasSystem && newIsSystem) {
            // Переключаемся с mic на system - останавливаем mic
            await stopAudioCapture();
        } else if (prevWasSystem && newIsSystem) {
            // Переключаемся между system и mixed - останавливаем mic если был mixed
            if (previousType === 'mixed') {
                await stopAudioCapture();
            }
        } else {
            // Переключаемся между mic и mic (не должно быть, но на всякий случай)
            await stopAudioCapture();
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Переподписываемся на чанки (для system/mixed не нужно запускать Rust захват)
        await rebuildRecorderWithStream();
        
        // Для mic режима запускаем Rust захват
        if (newType === 'mic') {
            let deviceId: string | undefined;
            try {
                const settings = await window.api.settings.get();
                deviceId = settings.audioInputDeviceId || undefined;
            } catch {
            }
            await startAudioCapture('mic', deviceId);
        } else if (newType === 'mixed') {
            // Для mixed режима запускаем только mic через Rust, system уже есть из getDisplayMedia
            let deviceId: string | undefined;
            try {
                const settings = await window.api.settings.get();
                deviceId = settings.audioInputDeviceId || undefined;
            } catch {
            }
            await startAudioCapture('mic', deviceId);
        }
        
        return { success: true };
    } catch (error) {
        console.error('Error switching audio input', error);
        setStatus('Failed to switch audio input', 'error');
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
