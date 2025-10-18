import {AudioRingBuffer} from '../audio/ringBuffer.js';
import {AudioVisualizer} from '../audio/visualizer.js';
import {PcmRingBuffer} from '../audio/pcmRingBuffer.js';
import {ensureWave, hideWave, showWave} from '../ui/waveform.js';
import {state} from '../state/appState.js';
import {logger} from '../utils/logger.js';
import {setStatus} from '../ui/status.js';

let media: MediaRecorder | null = null;
let ring: AudioRingBuffer | null = null;
let mimeSelected = 'audio/webm';
let visualizer: AudioVisualizer | null = null;
let waveWrap: HTMLDivElement | null = null;
let waveCanvas: HTMLCanvasElement | null = null;
let currentStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let srcNode: MediaStreamAudioSourceNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let pcmRing: PcmRingBuffer | null = null;
let currentAudioInputType: 'microphone' | 'system' = 'microphone';
let persistentSystemAudioTrack: MediaStreamTrack | null = null;

type SwitchOptions = { preStream?: MediaStream; gesture?: boolean };

export type SwitchAudioResult = {
    success: boolean;
    stream?: MediaStream;
    error?: string;
};

export function getAudioInputType(): 'microphone' | 'system' {
    return currentAudioInputType;
}

export function setAudioInputType(type: 'microphone' | 'system'): void {
    currentAudioInputType = type;
}

export function getCurrentStream(): MediaStream | null {
    return currentStream;
}

export function getPcmBuffer(): PcmRingBuffer | null {
    return pcmRing;
}

export function getRingBuffer(): AudioRingBuffer | null {
    return ring;
}

export function getPersistentSystemTrack(): MediaStreamTrack | null {
    return persistentSystemAudioTrack;
}

function setPersistentSystemTrack(track: MediaStreamTrack | null) {
    if (persistentSystemAudioTrack && persistentSystemAudioTrack !== track) {
        try {
            persistentSystemAudioTrack.stop();
        } catch {
        }
    }
    persistentSystemAudioTrack = track;
    if (persistentSystemAudioTrack) {
        try {
            persistentSystemAudioTrack.onended = () => {
                persistentSystemAudioTrack = null;
            };
        } catch {
        }
    }
}

export function registerPersistentSystemTrack(track: MediaStreamTrack | null): void {
    setPersistentSystemTrack(track);
}

function cleanupRecorder() {
    try {
        media?.stop();
    } catch {
    }
    try {
        media?.stream.getTracks().forEach((t) => t.stop());
    } catch {
    }
    media = null;
}

function cleanupAudioGraph() {
    try {
        scriptNode?.disconnect();
    } catch {
    }
    try {
        srcNode?.disconnect();
    } catch {
    }
    scriptNode = null;
    srcNode = null;
    try {
        audioCtx?.close();
    } catch {
    }
    audioCtx = null;
    pcmRing = null;
}

export async function startRecording(): Promise<MediaStream> {
    logger.info('recording', 'Starting recording');
    const stream = await getSystemAudioStream();
    const mime = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : (MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg' : '');
    if (!mime) {
        throw new Error('Unsupported: no suitable audio mime');
    }
    mimeSelected = mime;
    logger.info('recording', 'Recording started', { mime });

    ring = new AudioRingBuffer(state.durationSec);
    media = new MediaRecorder(stream, { mimeType: mimeSelected });
    currentStream = stream;

    const wave = ensureWave();
    waveWrap = wave.wrap;
    waveCanvas = wave.canvas;
    showWave(waveWrap);
    if (!visualizer) {
        visualizer = new AudioVisualizer();
    }
    visualizer.start(stream, waveCanvas, { bars: 72, smoothing: 0.75 });

    try {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        srcNode = audioCtx.createMediaStreamSource(stream);
        const channels = Math.max(1, srcNode.channelCount || 1);
        scriptNode = audioCtx.createScriptProcessor(4096, channels, channels);
        pcmRing = new PcmRingBuffer(audioCtx.sampleRate, channels, state.durationSec);
        scriptNode.onaudioprocess = (ev) => {
            const ib = ev.inputBuffer;
            const chs = ib.numberOfChannels;
            const frames = ib.length;
            const data: Float32Array[] = [];
            for (let c = 0; c < chs; c++) {
                data.push(new Float32Array(ib.getChannelData(c)));
            }
            pcmRing?.push(data, frames);
        };
        srcNode.connect(scriptNode);
        scriptNode.connect(audioCtx.destination);
    } catch {
    }

    const timeslice = 1000;
    media.addEventListener('dataavailable', (ev) => {
        if (!ev.data || ev.data.size === 0 || !ring) return;
        ring.push({ t: Date.now(), blob: ev.data, ms: timeslice } as any);
    });
    media.addEventListener('error', (ev) => {
        try {
            console.error('[mediaRecorder] error', (ev as any).error);
        } catch {
        }
    });
    media.start(timeslice);
    return stream;
}

export async function stopRecording(): Promise<void> {
    logger.info('recording', 'Stopping recording');
    cleanupRecorder();
    currentStream = null;
    cleanupAudioGraph();
    if (visualizer) {
        visualizer.stop();
    }
    if (waveWrap) {
        hideWave(waveWrap);
    }

    try {
        await window.api.loopback.disable();
    } catch (error) {
        console.error('Error disabling loopback audio:', error);
    }
}

export async function switchAudioInput(newType: 'microphone' | 'system', opts?: SwitchOptions): Promise<SwitchAudioResult> {
    logger.info('audio', 'Switch input requested', { newType });

    // Update cached type immediately
    currentAudioInputType = newType;

    const isRecording = state.isRecording;
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
                        currentAudioInputType = (s.audioInputType || 'microphone') as 'microphone' | 'system';
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
                    currentAudioInputType = 'microphone';
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
        if (waveCanvas) {
            if (!visualizer) {
                visualizer = new AudioVisualizer();
            }
            visualizer.start(stream, waveCanvas, { bars: 72, smoothing: 0.75 });
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
        return { success: false, error: 'rebuild-failed' };
    }

    return { success: true, stream };
}

async function rebuildRecorderWithStream(stream: MediaStream) {
    const timeslice = 1000;
    cleanupRecorder();
    media = new MediaRecorder(stream, { mimeType: mimeSelected });
    currentStream = stream;
    media.addEventListener('dataavailable', (ev) => {
        if (!ev.data || ev.data.size === 0 || !ring) return;
        ring.push({ t: Date.now(), blob: ev.data, ms: timeslice } as any);
    });
    media.addEventListener('error', (ev) => {
        try {
            console.error('[mediaRecorder] error', (ev as any).error);
        } catch {
        }
    });
    media.start(timeslice);
}

async function rebuildAudioGraph(stream: MediaStream) {
    try {
        scriptNode?.disconnect();
    } catch {
    }
    try {
        srcNode?.disconnect();
    } catch {
    }
    try {
        await audioCtx?.close();
    } catch {
    }
    audioCtx = null;
    srcNode = null;
    scriptNode = null;
    try {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const tmpSrc = audioCtx.createMediaStreamSource(stream);
        const ch = Math.max(1, tmpSrc.channelCount || 1);
        const sp = audioCtx.createScriptProcessor(4096, ch, ch);
        if (!pcmRing) {
            pcmRing = new PcmRingBuffer(audioCtx.sampleRate, ch, state.durationSec);
        }
        sp.onaudioprocess = (ev) => {
            const ib = ev.inputBuffer;
            const chs = ib.numberOfChannels;
            const frames = ib.length;
            const data: Float32Array[] = [];
            for (let c = 0; c < chs; c++) {
                data.push(new Float32Array(ib.getChannelData(c)));
            }
            pcmRing?.push(data, frames);
        };
        tmpSrc.connect(sp);
        sp.connect(audioCtx.destination);
        srcNode = tmpSrc;
        scriptNode = sp;
    } catch (error) {
        console.error('Failed to rebuild audio graph', error);
    }
}

async function getSystemAudioStream(): Promise<MediaStream> {
    try {
        const audioInputType = currentAudioInputType || 'microphone';

        if (audioInputType === 'system') {
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
                console.error('Error getting system audio:', error);
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
                } catch (fallbackError) {
                    console.error('desktopCapturer fallback failed', fallbackError);
                }
                return navigator.mediaDevices.getUserMedia({ audio: true });
            }
        } else {
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
    } catch (error) {
        console.error('Error getting audio stream:', error);
        return navigator.mediaDevices.getUserMedia({ audio: true });
    }
}

export function getLastSecondsFloats(seconds: number): { channels: Float32Array[]; sampleRate: number } | null {
    if (!pcmRing) return null;
    return pcmRing.getLastSecondsFloats(seconds);
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

export function clonePersistentSystemTrack(): MediaStreamTrack | null {
    if (persistentSystemAudioTrack && persistentSystemAudioTrack.readyState === 'live') {
        try {
            return persistentSystemAudioTrack.clone();
        } catch {
            return null;
        }
    }
    return null;
}

export function updateVisualizerBars(options: { stream: MediaStream; bars: number; smoothing: number }) {
    if (!visualizer || !waveCanvas) return;
    visualizer.start(options.stream, waveCanvas, { bars: options.bars, smoothing: options.smoothing });
}
