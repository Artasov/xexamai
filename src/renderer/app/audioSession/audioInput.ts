import {audioSessionState, AudioInputType} from './internalState';
import {setStatus} from '../../ui/status';
import {state as appState} from '../../state/appState';
import {startAudioCapture, stopAudioCapture} from '../../services/nativeAudio';

export type SwitchOptions = {};
export type SwitchAudioResult = { success: boolean; error?: string };

export async function switchAudioInput(newType: AudioInputType): Promise<SwitchAudioResult> {
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
        // Stop capture and wait a bit for cleanup
        await stopAudioCapture();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const source: 'mic' | 'system' | 'mixed' = 
            newType === 'system' ? 'system' : newType === 'mixed' ? 'mixed' : 'mic';
        
        let deviceId: string | undefined;
        if (source === 'mic' || source === 'mixed') {
            try {
                const settings = await window.api.settings.get();
                deviceId = settings.audioInputDeviceId || undefined;
            } catch {
            }
        }
        
        await startAudioCapture(source, deviceId);
        return { success: true };
    } catch (error) {
        console.error('Error switching audio input', error);
        setStatus('Failed to switch audio input', 'error');
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
