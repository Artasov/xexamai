import {initControls, updateButtonsState, updateDurations} from './ui/controls.js';
import {setStatus} from './ui/status.js';
import {showAnswer, showText} from './ui/outputs.js';
import {state, setProcessing} from './state/appState.js';
import {AudioRingBuffer} from './audio/ringBuffer.js';
import {AudioVisualizer} from './audio/visualizer.js';
import {ensureWave, hideWave, showWave} from './ui/waveform.js';
import {floatsToWav} from './audio/encoder.js';
import {PcmRingBuffer} from './audio/pcmRingBuffer.js';
import {SettingsPanel} from './ui/settings.js';

import type { AssistantAPI } from './types.js';

declare global {
    interface Window { api: AssistantAPI; }
}

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

async function getSystemAudioStream(): Promise<MediaStream> {
    try {
        const settings = await window.api.settings.get();
        const audioInputType = settings.audioInputType || 'microphone';
        
        if (audioInputType === 'system') {
            try {
                await window.api.loopback.enable();
                
                const disp = await navigator.mediaDevices.getDisplayMedia({audio: true, video: true});
                const audioTracks = disp.getAudioTracks();
                const stream = new MediaStream(audioTracks);
                
                disp.getVideoTracks().forEach((t) => t.stop());
                
                return stream;
            } catch (error) {
                console.error('Error getting system audio:', error);
                return navigator.mediaDevices.getUserMedia({audio: true});
            }
        } else {
            const deviceId = settings.audioInputDeviceId;
            
            if (deviceId) {
                return navigator.mediaDevices.getUserMedia({
                    audio: {
                        deviceId: { exact: deviceId }
                    }
                });
            } else {
                return navigator.mediaDevices.getUserMedia({audio: true});
            }
        }
    } catch (error) {
        console.error('Error getting audio stream:', error);
        return navigator.mediaDevices.getUserMedia({audio: true});
    }
}

async function startRecording() {
    const stream = await getSystemAudioStream();
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : (MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg' : '');
    if (!mime) throw new Error('Unsupported: no suitable audio mime');
    mimeSelected = mime;

    ring = new AudioRingBuffer(state.durationSec);
    media = new MediaRecorder(stream, { mimeType: mimeSelected });
    currentStream = stream;

    const wave = ensureWave();
    waveWrap = wave.wrap; waveCanvas = wave.canvas; showWave(waveWrap);
    if (!visualizer) visualizer = new AudioVisualizer();
    visualizer.start(stream, waveCanvas, { bars: 72, smoothing: 0.75 });

    try {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        srcNode = audioCtx.createMediaStreamSource(stream);
        const ch = Math.max(1, srcNode.channelCount || 1);
        scriptNode = audioCtx.createScriptProcessor(4096, ch, ch);
        pcmRing = new PcmRingBuffer(audioCtx.sampleRate, ch, state.durationSec);
        scriptNode.onaudioprocess = (ev) => {
            const ib = ev.inputBuffer;
            const chs = ib.numberOfChannels;
            const frames = ib.length;
            const data: Float32Array[] = [];
            for (let c = 0; c < chs; c++) data.push(new Float32Array(ib.getChannelData(c)));
            pcmRing?.push(data, frames);
        };
        srcNode.connect(scriptNode);
        scriptNode.connect(audioCtx.destination);
    } catch {}

    const timeslice = 1000;
    media.addEventListener('dataavailable', (ev) => {
        if (!ev.data || ev.data.size === 0 || !ring) return;
        ring.push({ t: Date.now(), blob: ev.data, ms: timeslice } as any);
    });
    media.addEventListener('error', (ev) => { try { console.error('[mediaRecorder] error', ev.error); } catch {} });
    media.start(timeslice);
}

async function stopRecording() {
    media?.stop();
    media?.stream.getTracks().forEach((t) => t.stop());
    media = null; currentStream = null;
    try { scriptNode?.disconnect(); } catch {}
    try { srcNode?.disconnect(); } catch {}
    scriptNode = null; srcNode = null;
    try { audioCtx?.close(); } catch {}
    audioCtx = null; pcmRing = null;
    if (visualizer) visualizer.stop();
    if (waveWrap) hideWave(waveWrap);
    
    try {
        await window.api.loopback.disable();
    } catch (error) {
        console.error('Error disabling loopback audio:', error);
    }
}

async function handleAskWindow(seconds: number) {
    if (!pcmRing) { setStatus('No audio', 'error'); return; }
    
    setProcessing(true);
    updateButtonsState();
    
    setStatus('Recognizing...', 'processing');
    showText(''); showAnswer('');

    const pcm = pcmRing.getLastSecondsFloats(seconds);
    if (!pcm || pcm.channels[0].length === 0) {
        setStatus('No audio in buffer', 'error');
        setProcessing(false);
        updateButtonsState();
        return;
    }
    const wav = floatsToWav(pcm.channels, pcm.sampleRate);
    const arrayBuffer = await wav.arrayBuffer();
    const requestId = `ask-window-${seconds}-` + Date.now();

    try {
        const transcribeRes = await window.api.assistant.transcribeOnly({
            arrayBuffer,
            mime: 'audio/wav',
            filename: `last_${seconds}s.wav`,
            audioSeconds: seconds,
        });

        if (!transcribeRes.ok) {
            setStatus('Error', 'error');
            showAnswer('Error: ' + transcribeRes.error);
            setProcessing(false);
            updateButtonsState();
            return;
        }

        showText(transcribeRes.text);
        
        setStatus('Sending to ChatGPT...', 'sending');
        
        try {
            (window.api.assistant as any).offStreamTranscript?.();
            (window.api.assistant as any).offStreamDelta?.();
            (window.api.assistant as any).offStreamDone?.();
            (window.api.assistant as any).offStreamError?.();
        } catch {}
        
        let acc = '';
        window.api.assistant.onStreamDelta((_e: unknown, p: { requestId?: string; delta: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            acc += p.delta || '';
            showAnswer(acc);
            setStatus('Responding...', 'processing');
        });
        window.api.assistant.onStreamDone((_e: unknown, p: { requestId?: string; full: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            setStatus('Done', 'ready');
            setProcessing(false);
            updateButtonsState();
        });
        window.api.assistant.onStreamError((_e: unknown, p: { requestId?: string; error: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            setStatus('Error', 'error');
            showAnswer('Error: ' + p.error);
            setProcessing(false);
            updateButtonsState();
        });

        await window.api.assistant.askChat({
            text: transcribeRes.text,
            requestId,
        });
        
    } catch (error) {
        setStatus('Error', 'error');
        showAnswer('Error: ' + (error as any)?.message || String(error));
        setProcessing(false);
        updateButtonsState();
    }
}

async function handleTextSend(text: string) {
    setProcessing(true);
    updateButtonsState();
    
    showText(text);
    showAnswer('');
    
    const textInput = document.getElementById('textInput') as HTMLTextAreaElement | null;
    if (textInput) {
        textInput.value = '';
    }
    
    const requestId = `text-send-${Date.now()}`;
    
    try {
        setStatus('Sending to ChatGPT...', 'sending');
        
        try {
            (window.api.assistant as any).offStreamTranscript?.();
            (window.api.assistant as any).offStreamDelta?.();
            (window.api.assistant as any).offStreamDone?.();
            (window.api.assistant as any).offStreamError?.();
        } catch {}
        
        let acc = '';
        window.api.assistant.onStreamDelta((_e: unknown, p: { requestId?: string; delta: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            acc += p.delta || '';
            showAnswer(acc);
            setStatus('Responding...', 'processing');
        });
        window.api.assistant.onStreamDone((_e: unknown, p: { requestId?: string; full: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            setStatus('Done', 'ready');
            setProcessing(false);
            updateButtonsState();
        });
        window.api.assistant.onStreamError((_e: unknown, p: { requestId?: string; error: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            setStatus('Error', 'error');
            showAnswer('Error: ' + p.error);
            setProcessing(false);
            updateButtonsState();
        });

        await window.api.assistant.askChat({
            text,
            requestId,
        });
        
    } catch (error) {
        setStatus('Error', 'error');
        showAnswer('Error: ' + (error as any)?.message || String(error));
        setProcessing(false);
        updateButtonsState();
    }
}

async function main() {
    const {durations} = await window.api.settings.get();
    if (Array.isArray(durations) && durations.length) {
        try { (state as any).durationSec = Math.max(...durations); } catch {}
    }
    initControls({
        durations,
        onRecordToggle: async (shouldRecord) => { if (shouldRecord) await startRecording(); else await stopRecording(); },
        onDurationChange: (sec) => { handleAskWindow(sec); },
        onTextSend: (text) => { handleTextSend(text); },
    });
    
    const settingsPanelContainer = document.getElementById('settingsPanel');
    if (settingsPanelContainer) {
        new SettingsPanel(settingsPanelContainer, {
            onDurationsChange: (newDurations) => {
                updateDurations(newDurations, (sec) => { handleAskWindow(sec); });
                try { (state as any).durationSec = Math.max(...newDurations); } catch {}
            }
        });
    }
    
    const mainTab = document.getElementById('mainTab');
    const settingsTab = document.getElementById('settingsTab');
    const mainContent = document.getElementById('mainContent');
    const settingsContent = document.getElementById('settingsContent');
    
    if (mainTab && settingsTab && mainContent && settingsContent) {
        mainTab.addEventListener('click', () => {
            mainTab.classList.add('active');
            settingsTab.classList.remove('active');
            mainContent.classList.remove('hidden');
            settingsContent.classList.add('hidden');
        });
        
        settingsTab.addEventListener('click', () => {
            settingsTab.classList.add('active');
            mainTab.classList.remove('active');
            settingsContent.classList.remove('hidden');
            mainContent.classList.add('hidden');
        });
    }
    
    const minimizeBtn = document.getElementById('minimizeBtn');
    const closeBtn = document.getElementById('closeBtn');
    
    if (minimizeBtn) {
        minimizeBtn.addEventListener('click', () => {
            window.api.window.minimize();
        });
    }
    
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            window.api.window.close();
        });
    }
}

main().catch((e) => { console.error(e); setStatus('Initialization error', 'error'); });

async function recordFromStream(stream: MediaStream, seconds: number, mime: string): Promise<Blob> {
    return new Promise<Blob>((resolve) => {
        const rec = new MediaRecorder(stream, { mimeType: mime });
        const chunks: Blob[] = [];
        rec.addEventListener('dataavailable', (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); });
        rec.addEventListener('stop', () => { resolve(new Blob(chunks, { type: mime })); });
        rec.start();
        setTimeout(() => rec.stop(), Math.max(250, seconds * 1000));
    });
}

