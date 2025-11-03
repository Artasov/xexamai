import {AudioRingBuffer} from '../../audio/ringBuffer';
import {AudioVisualizer} from '../../audio/visualizer';
import {PcmRingBuffer} from '../../audio/pcmRingBuffer';
import {ensureWave, hideWave, showWave} from '../../ui/waveform';
import {state as appState} from '../../state/appState';
import {logger} from '../../utils/logger';
import {audioSessionState} from './internalState';
import {setPersistentSystemTrack} from './systemTrack';

const timesliceMs = 1000;

export async function startRecording(): Promise<MediaStream> {
    logger.info('recording', 'Starting recording');
    const stream = await getSystemAudioStream();

    const mime = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : (MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg' : '');
    if (!mime) {
        throw new Error('Unsupported: no suitable audio mime');
    }
    audioSessionState.mimeSelected = mime;
    logger.info('recording', 'Recording started', { mime });

    audioSessionState.ring = new AudioRingBuffer(appState.durationSec);
    audioSessionState.media = new MediaRecorder(stream, { mimeType: audioSessionState.mimeSelected });
    audioSessionState.currentStream = stream;

    const wave = ensureWave();
    audioSessionState.waveWrap = wave.wrap;
    audioSessionState.waveCanvas = wave.canvas;
    showWave(audioSessionState.waveWrap);
    if (!audioSessionState.visualizer) {
        audioSessionState.visualizer = new AudioVisualizer();
    }
    audioSessionState.visualizer.start(stream, audioSessionState.waveCanvas, { bars: 72, smoothing: 0.75 });

    try {
        audioSessionState.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        audioSessionState.srcNode = audioSessionState.audioCtx.createMediaStreamSource(stream);
        const channels = Math.max(1, audioSessionState.srcNode.channelCount || 1);
        audioSessionState.scriptNode = audioSessionState.audioCtx.createScriptProcessor(4096, channels, channels);
        audioSessionState.pcmRing = new PcmRingBuffer(audioSessionState.audioCtx.sampleRate, channels, appState.durationSec);
        audioSessionState.scriptNode.onaudioprocess = (ev) => {
            const ib = ev.inputBuffer;
            const chs = ib.numberOfChannels;
            const frames = ib.length;
            const data: Float32Array[] = [];
            for (let c = 0; c < chs; c++) {
                data.push(new Float32Array(ib.getChannelData(c)));
            }
            audioSessionState.pcmRing?.push(data, frames);
        };
        audioSessionState.srcNode.connect(audioSessionState.scriptNode);
        audioSessionState.scriptNode.connect(audioSessionState.audioCtx.destination);
    } catch {
    }

    audioSessionState.media.addEventListener('dataavailable', (ev) => {
        if (!ev.data || ev.data.size === 0 || !audioSessionState.ring) return;
        audioSessionState.ring.push({ t: Date.now(), blob: ev.data, ms: timesliceMs } as any);
    });
    audioSessionState.media.addEventListener('error', (ev) => {
        try {
            console.error('[mediaRecorder] error', (ev as any).error);
        } catch {
        }
    });
    audioSessionState.media.start(timesliceMs);
    return stream;
}

export async function stopRecording(): Promise<void> {
    logger.info('recording', 'Stopping recording');
    cleanupRecorder();
    audioSessionState.currentStream = null;
    await cleanupAudioGraph();
    if (audioSessionState.visualizer) {
        audioSessionState.visualizer.stop();
    }
    if (audioSessionState.waveWrap) {
        hideWave(audioSessionState.waveWrap);
    }

    try {
        await window.api.loopback.disable();
    } catch (error) {
        console.error('Error disabling loopback audio:', error);
    }
}

export function getLastSecondsFloats(seconds: number): { channels: Float32Array[]; sampleRate: number } | null {
    if (!audioSessionState.pcmRing) return null;
    return audioSessionState.pcmRing.getLastSecondsFloats(seconds);
}

export async function recordFromStream(stream: MediaStream, seconds: number, mime: string): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
        try {
            const recorder = new MediaRecorder(stream, { mimeType: mime });
            const chunks: Blob[] = [];
            recorder.addEventListener('dataavailable', (ev) => {
                if (ev.data && ev.data.size > 0) {
                    chunks.push(ev.data);
                }
            });
            recorder.addEventListener('error', (err) => reject((err as any).error || err));
            recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: mime })));
            recorder.start();
            setTimeout(() => {
                try {
                    recorder.stop();
                } catch (err) {
                    reject(err);
                }
            }, seconds * 1000);
        } catch (error) {
            reject(error);
        }
    });
}

export function updateVisualizerBars(options: { stream: MediaStream; bars: number; smoothing: number }) {
    if (!audioSessionState.visualizer || !audioSessionState.waveCanvas) return;
    audioSessionState.visualizer.start(options.stream, audioSessionState.waveCanvas, {
        bars: options.bars,
        smoothing: options.smoothing,
    });
}

export async function rebuildRecorderWithStream(stream: MediaStream) {
    cleanupRecorder();
    audioSessionState.media = new MediaRecorder(stream, { mimeType: audioSessionState.mimeSelected });
    audioSessionState.currentStream = stream;
    audioSessionState.media.addEventListener('dataavailable', (ev) => {
        if (!ev.data || ev.data.size === 0 || !audioSessionState.ring) return;
        audioSessionState.ring.push({ t: Date.now(), blob: ev.data, ms: timesliceMs } as any);
    });
    audioSessionState.media.addEventListener('error', (ev) => {
        try {
            console.error('[mediaRecorder] error', (ev as any).error);
        } catch {
        }
    });
    audioSessionState.media.start(timesliceMs);
}

export async function rebuildAudioGraph(stream: MediaStream) {
    try {
        audioSessionState.scriptNode?.disconnect();
    } catch {
    }
    try {
        audioSessionState.srcNode?.disconnect();
    } catch {
    }
    try {
        await audioSessionState.audioCtx?.close();
    } catch {
    }
    audioSessionState.audioCtx = null;
    audioSessionState.srcNode = null;
    audioSessionState.scriptNode = null;

    try {
        audioSessionState.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const src = audioSessionState.audioCtx.createMediaStreamSource(stream);
        const channels = Math.max(1, src.channelCount || 1);
        const script = audioSessionState.audioCtx.createScriptProcessor(4096, channels, channels);
        if (!audioSessionState.pcmRing) {
            audioSessionState.pcmRing = new PcmRingBuffer(audioSessionState.audioCtx.sampleRate, channels, appState.durationSec);
        }
        script.onaudioprocess = (ev) => {
            const ib = ev.inputBuffer;
            const chs = ib.numberOfChannels;
            const frames = ib.length;
            const data: Float32Array[] = [];
            for (let c = 0; c < chs; c++) {
                data.push(new Float32Array(ib.getChannelData(c)));
            }
            audioSessionState.pcmRing?.push(data, frames);
        };
        src.connect(script);
        script.connect(audioSessionState.audioCtx.destination);
        audioSessionState.srcNode = src;
        audioSessionState.scriptNode = script;
    } catch (error) {
        console.error('Failed to rebuild audio graph', error);
    }
}

export async function getSystemAudioStream(): Promise<MediaStream> {
    const audioInputType = audioSessionState.currentAudioInputType || 'microphone';

    if (audioInputType !== 'system') {
        let deviceId: string | undefined;
        try {
            deviceId = (await window.api.settings.get()).audioInputDeviceId;
        } catch {
        }

        if (deviceId) {
            return navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: { exact: deviceId },
                },
            });
        }
        return navigator.mediaDevices.getUserMedia({ audio: true });
    }

    const errors: unknown[] = [];

    try {
        try {
            (window as any).api?.loopback?.enable?.();
        } catch {
        }
        const disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        const audioTracks = disp.getAudioTracks();
        const sysTrack = audioTracks[0] || null;
        let stream: MediaStream;
        if (sysTrack) {
            setPersistentSystemTrack(sysTrack);
            const clone = sysTrack.clone();
            stream = new MediaStream([clone]);
        } else {
            stream = new MediaStream(audioTracks);
        }
        disp.getVideoTracks().forEach((t) => t.stop());
        try {
            await window.api.loopback.enable();
        } catch {
        }
        return stream;
    } catch (error) {
        console.error('Error getting system audio via getDisplayMedia:', error);
        errors.push(error);
    }

    try {
        const sourceId = await (window as any).api?.media?.getPrimaryDisplaySourceId?.();
        const gumConstraints: any = sourceId
            ? {
                  audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
                  video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
              }
            : {
                  audio: { mandatory: { chromeMediaSource: 'desktop' } },
                  video: { mandatory: { chromeMediaSource: 'desktop' } },
              };
        const stream = await navigator.mediaDevices.getUserMedia(gumConstraints as any);
        const audioTracks = stream.getAudioTracks();
        const sysTrack = audioTracks[0] || null;
        let out: MediaStream;
        if (sysTrack) {
            setPersistentSystemTrack(sysTrack);
            const clone = sysTrack.clone();
            out = new MediaStream([clone]);
        } else {
            out = new MediaStream(audioTracks);
        }
        try {
            stream.getVideoTracks().forEach((t) => t.stop());
        } catch {
        }
        try {
            await window.api.loopback.enable();
        } catch {
        }
        return out;
    } catch (error) {
        console.error('desktopCapturer fallback failed', error);
        errors.push(error);
        try {
            await window.api.loopback.disable();
        } catch {
        }
        const captureError = new Error('system-audio-capture-failed');
        (captureError as any).code = 'system-audio-capture-failed';
        (captureError as any).details = errors
            .map((err) => {
                if (!err) return '';
                return err instanceof Error ? err.message : String(err);
            })
            .filter((msg) => typeof msg === 'string' && msg.length > 0);
        throw captureError;
    }
}

function cleanupRecorder() {
    try {
        audioSessionState.media?.stop();
    } catch {
    }
    try {
        audioSessionState.media?.stream.getTracks().forEach((t) => t.stop());
    } catch {
    }
    audioSessionState.media = null;
}

async function cleanupAudioGraph() {
    try {
        audioSessionState.scriptNode?.disconnect();
    } catch {
    }
    try {
        audioSessionState.srcNode?.disconnect();
    } catch {
    }
    try {
        await audioSessionState.audioCtx?.close();
    } catch {
    }
    audioSessionState.audioCtx = null;
    audioSessionState.srcNode = null;
    audioSessionState.scriptNode = null;
    audioSessionState.pcmRing = null;
}
