import {setStatus} from '../../ui/status';
import {state as appState} from '../../state/appState';
import {logger} from '../../utils/logger';
import {AudioVisualizer} from '../../audio/visualizer';
import {audioSessionState} from './internalState';
import {rebuildAudioGraph, rebuildRecorderWithStream} from './recorder';
import type {SwitchAudioResult, SwitchOptions} from './types';

export async function switchAudioInput(newType: 'microphone' | 'system', opts?: SwitchOptions): Promise<SwitchAudioResult> {
    logger.info('audio', 'Switch input requested', { newType });

    const previousType = audioSessionState.currentAudioInputType;
    audioSessionState.currentAudioInputType = newType;

    const isRecording = appState.isRecording;
    let stream: MediaStream | null = null;

    if (isRecording) {
        if (newType === 'system') {
            if (opts?.preStream) {
                stream = opts.preStream;
            } else {
                if (opts?.gesture === false) {
                    setStatus('Click MIC/SYS to capture system audio', 'error');
                    try {
                        const s = await window.api.settings.get();
                        audioSessionState.currentAudioInputType = (s.audioInputType || 'microphone') as 'microphone' | 'system';
                    } catch {
                    }
                    return { success: false, error: 'gesture-required' };
                }
                try {
                    const disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
                    const audioTracks = disp.getAudioTracks();
                    stream = new MediaStream(audioTracks);
                    disp.getVideoTracks().forEach((t) => t.stop());
                } catch (error) {
                    console.error('Error acquiring system audio stream:', error);
                    setStatus('System audio capture failed. Staying on microphone', 'error');
                    audioSessionState.currentAudioInputType = 'microphone';
                    return { success: false, error: 'capture-failed' };
                }
            }
        } else {
            try {
                let deviceId: string | undefined;
                try {
                    deviceId = (await window.api.settings.get()).audioInputDeviceId;
                } catch {
                }
                if (deviceId) {
                    stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } as any });
                } else {
                    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                }
            } catch (error) {
                console.error('Error acquiring microphone:', error);
                setStatus('Microphone capture failed', 'error');
                return { success: false, error: 'capture-failed' };
            }
        }
    }

    try {
        await window.api.settings.setAudioInputType(newType);
    } catch {
    }

    if (!isRecording) {
        return { success: true };
    }

    if (!stream) {
        return { success: false, error: 'no-stream' };
    }

    try {
        await rebuildRecorderWithStream(stream);
        await rebuildAudioGraph(stream);
        if (audioSessionState.waveCanvas) {
            if (!audioSessionState.visualizer) {
                audioSessionState.visualizer = new AudioVisualizer();
            }
            audioSessionState.visualizer.start(stream, audioSessionState.waveCanvas, { bars: 72, smoothing: 0.75 });
        }
        if (newType === 'system') {
            try {
                await window.api.loopback.enable();
            } catch {
            }
        } else {
            try {
                await window.api.loopback.disable();
            } catch {
            }
        }
    } catch (error) {
        console.error('Failed to rebuild audio pipeline after input switch', error);
        setStatus('Failed to switch audio input', 'error');
        audioSessionState.currentAudioInputType = previousType;
        return { success: false, error: 'rebuild-failed' };
    }

    return { success: true, stream };
}
