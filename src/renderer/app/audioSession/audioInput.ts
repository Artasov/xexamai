import {audioSessionState, AudioInputType} from './internalState';
import {setStatus} from '../../ui/status';
import {state as appState} from '../../state/appState';
import {startRecording, stopRecording} from './recorder';

export type SwitchOptions = {};
export type SwitchAudioResult = { success: boolean; error?: string };

export async function switchAudioInput(newType: AudioInputType): Promise<SwitchAudioResult> {
    const previousType = audioSessionState.currentAudioInputType;
    
    if (!appState.isRecording) {
        // If not recording, just update the type
        audioSessionState.currentAudioInputType = newType;
        try {
            await window.api.settings.setAudioInputType(newType);
        } catch {
        }
        return { success: true };
    }
    
    // While recording we need to restart capture with the new type
    try {
        try {
            await window.api.settings.setAudioInputType(newType);
        } catch {
        }
        
        // Stop the current capture completely
        await stopRecording();
        
        // Small delay to let resources clean up
        await new Promise(resolve => setTimeout(resolve, 150));
        
        // Update the input type
        audioSessionState.currentAudioInputType = newType;
        
        // Start capture with the new type
        await startRecording();
        
        return { success: true };
    } catch (error) {
        console.error('Error switching audio input', error);
        setStatus('Failed to switch audio input', 'error');
        // Restore the previous type on error
        audioSessionState.currentAudioInputType = previousType;
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
