import {audioSessionState, AudioInputType} from './internalState';
import {setStatus} from '../../ui/status';
import {state as appState} from '../../state/appState';
import {startRecording, stopRecording} from './recorder';

export type SwitchOptions = {};
export type SwitchAudioResult = { success: boolean; error?: string };

export async function switchAudioInput(newType: AudioInputType): Promise<SwitchAudioResult> {
    const previousType = audioSessionState.currentAudioInputType;
    
    if (!appState.isRecording) {
        // Если не записываем, просто обновляем тип
        audioSessionState.currentAudioInputType = newType;
        try {
            await window.api.settings.setAudioInputType(newType);
        } catch {
        }
        return { success: true };
    }
    
    // Во время записи нужно перезапустить захват с новым типом
    try {
        try {
            await window.api.settings.setAudioInputType(newType);
        } catch {
        }
        
        // Останавливаем текущий захват полностью
        await stopRecording();
        
        // Небольшая задержка для очистки
        await new Promise(resolve => setTimeout(resolve, 150));
        
        // Обновляем тип ввода
        audioSessionState.currentAudioInputType = newType;
        
        // Запускаем захват с новым типом
        await startRecording();
        
        return { success: true };
    } catch (error) {
        console.error('Error switching audio input', error);
        setStatus('Failed to switch audio input', 'error');
        // Восстанавливаем предыдущий тип при ошибке
        audioSessionState.currentAudioInputType = previousType;
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
