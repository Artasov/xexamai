import {logger} from '../utils/logger';

let systemAudioStream: MediaStream | null = null;
let systemAudioTrack: MediaStreamTrack | null = null;

/**
 * Запрашивает разрешение на захват экрана и системного звука
 * Вызывается при старте программы
 */
export async function requestSystemAudioPermission(): Promise<boolean> {
    try {
        logger.info('systemAudio', 'Requesting screen capture permission for system audio');
        
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                displaySurface: 'monitor',
            } as MediaTrackConstraints,
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            } as MediaTrackConstraints,
        });

        // Останавливаем видеотреки, они нам не нужны
        stream.getVideoTracks().forEach((track) => {
            track.stop();
        });

        // Проверяем наличие аудиотреков
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
            logger.warn('systemAudio', 'No audio tracks in screen capture stream');
            stream.getTracks().forEach((t) => t.stop());
            return false;
        }

        // Сохраняем поток и трек
        systemAudioStream = stream;
        systemAudioTrack = audioTracks[0];

        // Обработка остановки трека пользователем
        systemAudioTrack.onended = () => {
            logger.info('systemAudio', 'System audio track ended by user');
            systemAudioStream = null;
            systemAudioTrack = null;
        };

        logger.info('systemAudio', 'System audio permission granted');
        return true;
    } catch (error) {
        logger.error('systemAudio', 'Failed to request system audio permission', {error});
        return false;
    }
}

/**
 * Получает сохранённый системный аудиотрек
 */
export function getSystemAudioTrack(): MediaStreamTrack | null {
    if (systemAudioTrack && systemAudioTrack.readyState === 'live') {
        return systemAudioTrack;
    }
    return null;
}

/**
 * Получает сохранённый системный аудиопоток
 */
export function getSystemAudioStream(): MediaStream | null {
    if (systemAudioStream && systemAudioStream.active) {
        return systemAudioStream;
    }
    return null;
}

/**
 * Проверяет, есть ли активный системный аудиотрек
 */
export function hasSystemAudioPermission(): boolean {
    return systemAudioTrack !== null && systemAudioTrack.readyState === 'live';
}

/**
 * Останавливает системный аудиозахват
 */
export function stopSystemAudioCapture(): void {
    if (systemAudioStream) {
        systemAudioStream.getTracks().forEach((t) => t.stop());
        systemAudioStream = null;
    }
    systemAudioTrack = null;
}

