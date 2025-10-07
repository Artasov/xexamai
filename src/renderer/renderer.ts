import {initControls, updateButtonsState, updateDurations} from './ui/controls.js';
import {setStatus} from './ui/status.js';
import {showAnswer, showText} from './ui/outputs.js';
import {setProcessing, state} from './state/appState.js';
import {AudioRingBuffer} from './audio/ringBuffer.js';
import {AudioVisualizer} from './audio/visualizer.js';
import {ensureWave, hideWave, showWave} from './ui/waveform.js';
import {floatsToWav} from './audio/encoder.js';
import {PcmRingBuffer} from './audio/pcmRingBuffer.js';
import {SettingsPanel} from './ui/settings.js';
import {logger} from './utils/logger.js';
// Gemini SDK is loaded in preload and exposed via window.api.gemini

import type {AssistantAPI} from './types.js';

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
let currentRequestId: string | null = null;
let btnStop: HTMLButtonElement | null = null;
let activeOpId: number = 0;
// Stream mode variables
let streamModeContainer: HTMLElement | null = null;
let streamResults: HTMLTextAreaElement | null = null;
let btnSendStream: HTMLButtonElement | null = null;
let isStreamMode: boolean = false;
let geminiStreamingClient: any = null;
let geminiLiveSession: any = null; // kept only as flag; real session is in preload
// Current stream send hotkey (updated live from settings)
let currentStreamSendHotkey: string = '~';
// Current audio input type (kept in-memory to avoid async before getDisplayMedia)
let currentAudioInputType: 'microphone' | 'system' = 'microphone';
// Persisted system-audio track captured under a user gesture for reuse via hotkey
let persistentSystemAudioTrack: MediaStreamTrack | null = null;

// Font size management constants
const FONT_SIZE_KEY = 'xexamai-answer-font-size';
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 14;

async function updateToggleButtonLabel() {
    try {
        const btn = document.getElementById('btnToggleInput') as HTMLButtonElement | null;
        if (!btn) return;
        const settings = await window.api.settings.get();
        const t = (settings.audioInputType || 'microphone') as 'microphone' | 'system';
        currentAudioInputType = t;
        btn.textContent = t === 'microphone' ? 'MIC' : 'SYS';
        btn.title = t === 'microphone' ? 'Using Microphone' : 'Using System Audio';
    } catch {}
}

async function updateStreamModeVisibility() {
    try {
        const settings = await window.api.settings.get();
        const streamMode = settings.streamMode || 'base';
        isStreamMode = streamMode === 'stream';
        
        console.log('Updating stream mode visibility:', { streamMode, isStreamMode, streamModeContainer: !!streamModeContainer });
        
        if (streamModeContainer) {
            if (isStreamMode) {
                streamModeContainer.classList.remove('hidden');
                streamModeContainer.style.display = 'block';
            } else {
                streamModeContainer.classList.add('hidden');
                streamModeContainer.style.display = 'none';
            }
        } else {
            console.warn('streamModeContainer not found');
        }

        // Toggle durations (Send the last: 5s, 10s, 15s, ...) visibility opposite to stream mode
        try {
            const durationsContainer = document.getElementById('send-last-container') as HTMLDivElement | null;
            if (durationsContainer) {
                if (isStreamMode) {
                    durationsContainer.classList.add('hidden');
                    durationsContainer.style.display = 'none';
                } else {
                    durationsContainer.classList.remove('hidden');
                    durationsContainer.style.display = 'block';
                }
            }
        } catch {}
        
        if (isStreamMode && currentStream) {
            // Indicate we are preparing the Gemini stream before it becomes active
            try { setStatus('Preparing Gemini stream...', 'processing'); } catch {}
            // Start Gemini streaming if not already started
            await startGeminiStreaming();
        } else if (!isStreamMode && geminiStreamingClient) {
            // Stop Gemini streaming
            await stopGeminiStreaming();
        }
    } catch (error) {
        console.error('Error updating stream mode visibility:', error);
    }
}

async function startGeminiStreaming() {
    try {
        if (geminiStreamingClient) {
            await stopGeminiStreaming();
        }
        
        // Create Gemini streaming client
        geminiStreamingClient = createGeminiStreamingClient();
        
        geminiStreamingClient.onTranscript((text: string) => {
            if (streamResults) {
                streamResults.value += text + ' ';
                streamResults.scrollTop = streamResults.scrollHeight;
                // enable send button when there is text
                try {
                    const btn = btnSendStream as HTMLButtonElement | null;
                    if (btn) btn.disabled = !(streamResults.value.trim().length > 0);
                } catch {}
            }
        });
        
        geminiStreamingClient.onError((error: string) => {
            console.error('Gemini streaming error:', error);
            setStatus('Gemini error: ' + error, 'error');
        });
        
        if (currentStream) {
            await geminiStreamingClient.startStreaming(currentStream);
            setStatus('Gemini streaming active', 'processing');
        }
    } catch (error) {
        console.error('Failed to start Gemini streaming:', error);
        setStatus('Failed to start Gemini streaming', 'error');
    }
}

async function stopGeminiStreaming() {
    try {
        if (geminiStreamingClient) {
            await geminiStreamingClient.stopStreaming();
            geminiStreamingClient = null;
        }
        try {
            if (geminiLiveSession) {
                geminiLiveSession.close?.();
            }
        } catch {}
        // Ensure preload live session is stopped as well
        try { (window as any).api?.gemini?.stopLive?.(); } catch {}
        geminiLiveSession = null;
    } catch (error) {
        console.error('Error stopping Gemini streaming:', error);
    }
}

async function handleStreamTextSend() {
    if (!streamResults || !streamResults.value.trim()) return;
    
    const text = streamResults.value.trim();
    streamResults.value = '';
    
    await handleTextSend(text);
}

function createGeminiStreamingClient() {
    return {
        onTranscript: (callback: (text: string) => void) => {
            // Store callback for later use
            (window as any).geminiTranscriptCallback = callback;
        },
        onError: (callback: (error: string) => void) => {
            // Store callback for later use
            (window as any).geminiErrorCallback = callback;
        },
        startStreaming: async (stream: MediaStream) => {
            try {
                // Get Gemini API key from settings
                const settings = await window.api.settings.get();
                const apiKey = settings.geminiApiKey;
                
                if (!apiKey) {
                    throw new Error('Gemini API key not configured');
                }
                
                // Initialize Gemini Live session via preload bridge
                const responseQueue: any[] = [];

                function handleMessage(message: any) {
                    try {
                        // Prefer explicit transcriptions if present
                        const inputTx = message?.serverContent?.inputTranscription?.text;
                        const outputTx = message?.serverContent?.outputTranscription?.text;
                        const plainText = message?.text;
                        const text = inputTx || outputTx || plainText;
                        if (text && typeof text === 'string') {
                            (window as any).geminiTranscriptCallback?.(text);
                        }
                    } catch {}
                }
                await (window as any).api.gemini.startLive({
                    apiKey,
                    response: 'TEXT',
                    transcribeInput: true,
                    transcribeOutput: false,
                });
                (window as any).api.gemini.onMessage((message: any) => {
                    responseQueue.push(message);
                    handleMessage(message);
                });
                (window as any).api.gemini.onError((msg: string) => {
                    (window as any).geminiErrorCallback?.(msg || 'Unknown Gemini error');
                });

                // Create audio context for streaming
                const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                const source = audioContext.createMediaStreamSource(stream);
                const processor = audioContext.createScriptProcessor(4096, 1, 1);
                
                let audioBuffer: Float32Array[] = [];
                
                processor.onaudioprocess = (event) => {
                    const inputBuffer = event.inputBuffer;
                    const inputData = inputBuffer.getChannelData(0);
                    audioBuffer.push(new Float32Array(inputData));
                    
                    // Send ~2 seconds of audio per chunk
                    if (audioBuffer.length >= 20) {
                        processAudioChunk(audioBuffer, audioContext.sampleRate).catch((e) => {
                            try { console.error('Gemini chunk error', e); } catch {}
                        });
                        audioBuffer = [];
                    }
                };
                
                source.connect(processor);
                processor.connect(audioContext.destination);
                
                // Store references for cleanup
                (window as any).geminiAudioContext = audioContext;
                (window as any).geminiProcessor = processor;
                (window as any).geminiSource = source;
                
            } catch (error) {
                console.error('Failed to start Gemini streaming:', error);
                (window as any).geminiErrorCallback?.(`Failed to start streaming: ${error}`);
            }
        },
        stopStreaming: async () => {
            try {
                const audioContext = (window as any).geminiAudioContext;
                const processor = (window as any).geminiProcessor;
                const source = (window as any).geminiSource;
                
                if (processor) processor.disconnect();
                if (source) source.disconnect();
                if (audioContext) await audioContext.close();
                
                (window as any).geminiAudioContext = null;
                (window as any).geminiProcessor = null;
                (window as any).geminiSource = null;

                try { geminiLiveSession?.close?.(); } catch {}
                geminiLiveSession = null;
            } catch (error) {
                console.error('Error stopping Gemini streaming:', error);
            }
        }
    };
}

async function processAudioChunk(audioBuffer: Float32Array[], sampleRate: number) {
    try {
        // Combine audio buffers
        const totalLength = audioBuffer.reduce((sum, buffer) => sum + buffer.length, 0);
        const combinedBuffer = new Float32Array(totalLength);
        let offset = 0;
        
        for (const buffer of audioBuffer) {
            combinedBuffer.set(buffer, offset);
            offset += buffer.length;
        }
        // Resample mono to 16k PCM16 and convert to base64 (closer to Live API expectations)
        const pcm16 = float32ToPCM16Resampled(combinedBuffer, Math.max(8000, Math.floor(sampleRate || 16000)), 16000);
        const audioBase64 = bytesToBase64(new Uint8Array(pcm16.buffer));
        // Send audio chunk to Live session
        (window as any).api.gemini.sendAudioChunk({
            data: audioBase64,
            mime: 'audio/pcm;rate=16000',
        });
        
    } catch (error) {
        console.error('Error processing audio chunk:', error);
        (window as any).geminiErrorCallback?.(`Error processing audio: ${error}`);
    }
}

function bytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, Array.from(sub) as unknown as number[]);
    }
    return btoa(binary);
}

function float32ToPCM16Resampled(input: Float32Array, inRate: number, outRate: number): Int16Array {
    const clampedInRate = Math.max(8000, Math.floor(inRate || 16000));
    const targetRate = Math.max(8000, Math.floor(outRate || 16000));
    if (clampedInRate === targetRate) {
        const out = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i] || 0));
            out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        }
        return out;
    }
    const ratio = targetRate / clampedInRate;
    const outLen = Math.max(1, Math.floor(input.length * ratio));
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const t = i / ratio;
        const i0 = Math.floor(t);
        const i1 = Math.min(input.length - 1, i0 + 1);
        const frac = t - i0;
        const s0 = input[i0] || 0;
        const s1 = input[i1] || 0;
        const s = s0 + (s1 - s0) * frac;
        const ss = Math.max(-1, Math.min(1, s));
        out[i] = ss < 0 ? Math.round(ss * 0x8000) : Math.round(ss * 0x7fff);
    }
    return out;
}

async function rebuildRecorderWithStream(stream: MediaStream) {
    const timeslice = 1000;
    try {
        media?.stop();
    } catch {}
    try {
        media?.stream.getTracks().forEach((t) => t.stop());
    } catch {}
    media = new MediaRecorder(stream, { mimeType: mimeSelected });
    currentStream = stream;
    media.addEventListener('dataavailable', (ev) => {
        if (!ev.data || ev.data.size === 0 || !ring) return;
        ring.push({ t: Date.now(), blob: ev.data, ms: timeslice } as any);
    });
    media.addEventListener('error', (ev) => {
        try { console.error('[mediaRecorder] error', (ev as any).error); } catch {}
    });
    media.start(timeslice);
}

async function rebuildAudioGraph(stream: MediaStream) {
    try { scriptNode?.disconnect(); } catch {}
    try { srcNode?.disconnect(); } catch {}
    try { await audioCtx?.close(); } catch {}
    audioCtx = null;
    srcNode = null;
    scriptNode = null;
    try {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const tmpSrc = audioCtx.createMediaStreamSource(stream);
        const ch = Math.max(1, tmpSrc.channelCount || 1);
        const sp = audioCtx.createScriptProcessor(4096, ch, ch);
        if (!pcmRing) pcmRing = new PcmRingBuffer(audioCtx.sampleRate, ch, state.durationSec);
        sp.onaudioprocess = (ev) => {
            const ib = ev.inputBuffer;
            const chs = ib.numberOfChannels;
            const frames = ib.length;
            const data: Float32Array[] = [];
            for (let c = 0; c < chs; c++) data.push(new Float32Array(ib.getChannelData(c)));
            pcmRing?.push(data, frames);
        };
        tmpSrc.connect(sp);
        sp.connect(audioCtx.destination);
        srcNode = tmpSrc;
        scriptNode = sp;
    } catch {}
}

async function switchAudioInput(newType: 'microphone' | 'system', opts?: { preStream?: MediaStream; gesture?: boolean }) {
    logger.info('audio', 'Switch input requested', { newType });

    // Update in-memory value immediately
    currentAudioInputType = newType;

    const isRecording = state.isRecording;
    let stream: MediaStream | null = null;

    // If recording, try to acquire the new stream first (critical for system audio gesture)
    if (isRecording) {
        if (newType === 'system') {
            if (opts?.preStream) {
                stream = opts.preStream;
            } else {
                // If we don't have a user gesture, avoid calling getDisplayMedia to prevent InvalidStateError
                if (opts?.gesture === false) {
                    setStatus('Click MIC/SYS to capture system audio', 'error');
                    // Revert in-memory type to previous known to avoid confusion
                    try {
                        const s = await window.api.settings.get();
                        currentAudioInputType = (s.audioInputType || 'microphone') as 'microphone' | 'system';
                    } catch {}
                    return;
                }
                try {
                    // Must be called within user gesture
                    const disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
                    const audioTracks = disp.getAudioTracks();
                    stream = new MediaStream(audioTracks);
                    disp.getVideoTracks().forEach((t) => t.stop());
                } catch (error) {
                    console.error('Error acquiring system audio stream:', error);
                    setStatus('System audio capture failed. Staying on microphone', 'error');
                    // Revert memory value and bail
                    currentAudioInputType = 'microphone';
                    return;
                }
            }
        } else {
            // Microphone path
            try {
                let deviceId: string | undefined;
                try { deviceId = (await window.api.settings.get()).audioInputDeviceId; } catch {}
                if (deviceId) {
                    stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } as any });
                } else {
                    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                }
            } catch (error) {
                console.error('Error acquiring microphone:', error);
                setStatus('Microphone capture failed', 'error');
                return;
            }
        }
    }

    // Persist settings after we have a stream (so we don't save a broken state)
    try { await window.api.settings.setAudioInputType(newType); } catch {}
    await updateToggleButtonLabel();

    if (!isRecording) return;

    // Rebuild pipeline using the newly acquired stream
    if (stream) {
        try {
            await rebuildRecorderWithStream(stream);
            await rebuildAudioGraph(stream);
            if (waveCanvas) {
                if (!visualizer) visualizer = new AudioVisualizer();
                visualizer.start(stream, waveCanvas, { bars: 72, smoothing: 0.75 });
            }
            if (newType === 'system') {
                try { await window.api.loopback.enable(); } catch {}
            } else {
                try { await window.api.loopback.disable(); } catch {}
            }
        } catch (e) {
            console.error('Failed to rebuild audio pipeline after input switch', e);
            setStatus('Failed to switch audio input', 'error');
            return;
        }

        // Restart Gemini streaming if needed
        try {
            const s = await window.api.settings.get();
            if ((s.streamMode || 'base') === 'stream') {
                try { setStatus('Preparing Gemini stream...', 'processing'); } catch {}
                await startGeminiStreaming();
            } else {
                setStatus('Recording...', 'recording');
            }
        } catch {}
    }
}

async function getSystemAudioStream(): Promise<MediaStream> {
    try {
        const audioInputType = currentAudioInputType || 'microphone';

        if (audioInputType === 'system') {
            try {
                // Hint OS to prepare loopback before requesting capture (do not await to keep gesture)
                try { (window as any).api?.loopback?.enable?.(); } catch {}
                // Call getDisplayMedia first to satisfy transient activation requirement
                const disp = await navigator.mediaDevices.getDisplayMedia({audio: true, video: true});
                const audioTracks = disp.getAudioTracks();
                const sysTrack = audioTracks[0] || null;
                let stream: MediaStream;
                if (sysTrack) {
                    // Persist original system audio track and return a clone for recording
                    try { if (persistentSystemAudioTrack && persistentSystemAudioTrack !== sysTrack) persistentSystemAudioTrack.stop(); } catch {}
                    persistentSystemAudioTrack = sysTrack;
                    try { persistentSystemAudioTrack.onended = () => { persistentSystemAudioTrack = null; }; } catch {}
                    const clone = sysTrack.clone();
                    stream = new MediaStream([clone]);
                } else {
                    stream = new MediaStream(audioTracks);
                }
                disp.getVideoTracks().forEach((t) => t.stop());
                // Ensure loopback is enabled
                try { await window.api.loopback.enable(); } catch {}
                return stream;
            } catch (error) {
                console.error('Error getting system audio:', error);
                // Fallback: try Electron desktopCapturer-based capture without gesture
                try {
                    const sourceId = await (window as any).api?.media?.getPrimaryDisplaySourceId?.();
                    const gumConstraints: any = sourceId ? {
                        audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
                        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
                    } : {
                        audio: { mandatory: { chromeMediaSource: 'desktop' } },
                        video: { mandatory: { chromeMediaSource: 'desktop' } },
                    };
                    const stream = await navigator.mediaDevices.getUserMedia(gumConstraints as any);
                    const audioTracks = stream.getAudioTracks();
                    const sysTrack = audioTracks[0] || null;
                    let out: MediaStream;
                    if (sysTrack) {
                        try { if (persistentSystemAudioTrack && persistentSystemAudioTrack !== sysTrack) persistentSystemAudioTrack.stop(); } catch {}
                        persistentSystemAudioTrack = sysTrack;
                        try { persistentSystemAudioTrack.onended = () => { persistentSystemAudioTrack = null; }; } catch {}
                        const clone = sysTrack.clone();
                        out = new MediaStream([clone]);
                    } else {
                        out = new MediaStream(audioTracks);
                    }
                    try { stream.getVideoTracks().forEach(t => t.stop()); } catch {}
                    try { await window.api.loopback.enable(); } catch {}
                    return out;
                } catch (e) {
                    console.error('desktopCapturer fallback failed', e);
                }
                return navigator.mediaDevices.getUserMedia({audio: true});
            }
        } else {
            let deviceId: string | undefined;
            try { deviceId = (await window.api.settings.get()).audioInputDeviceId; } catch {}

            if (deviceId) {
                return navigator.mediaDevices.getUserMedia({
                    audio: {
                        deviceId: {exact: deviceId}
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
    logger.info('recording', 'Starting recording');
    const stream = await getSystemAudioStream();
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : (MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg' : '');
    if (!mime) throw new Error('Unsupported: no suitable audio mime');
    mimeSelected = mime;
    logger.info('recording', 'Recording started', { mime });

    ring = new AudioRingBuffer(state.durationSec);
    media = new MediaRecorder(stream, {mimeType: mimeSelected});
    currentStream = stream;

    const wave = ensureWave();
    waveWrap = wave.wrap;
    waveCanvas = wave.canvas;
    showWave(waveWrap);
    if (!visualizer) visualizer = new AudioVisualizer();
    visualizer.start(stream, waveCanvas, {bars: 72, smoothing: 0.75});

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
    } catch {
    }

    const timeslice = 1000;
    media.addEventListener('dataavailable', (ev) => {
        if (!ev.data || ev.data.size === 0 || !ring) return;
        ring.push({t: Date.now(), blob: ev.data, ms: timeslice} as any);
    });
    media.addEventListener('error', (ev) => {
        try {
            console.error('[mediaRecorder] error', (ev as any).error);
        } catch {
        }
    });
    media.start(timeslice);
    
    // Update stream mode visibility after starting recording
    await updateStreamModeVisibility();
}

async function stopRecording() {
    logger.info('recording', 'Stopping recording');
    media?.stop();
    media?.stream.getTracks().forEach((t) => t.stop());
    media = null;
    currentStream = null;
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
    if (visualizer) visualizer.stop();
    if (waveWrap) hideWave(waveWrap);

    try {
        await window.api.loopback.disable();
    } catch (error) {
        console.error('Error disabling loopback audio:', error);
    }
    
    // Stop Gemini streaming if active
    await stopGeminiStreaming();
}

async function handleAskWindow(seconds: number) {
    logger.info('ui', 'Handle ask window', { seconds });
    
    // In stream mode, ignore duration buttons
    if (isStreamMode) {
        return;
    }
    
    if (!pcmRing) {
        setStatus('No audio', 'error');
        return;
    }

    // Cancel any ongoing stream before starting a new one
    if (currentRequestId) {
        try { await window.api.assistant.stopStream({ requestId: currentRequestId }); } catch {}
        currentRequestId = null;
        if (btnStop) btnStop.classList.add('hidden');
        setStatus('Ready', 'ready');
        setProcessing(false);
        updateButtonsState();
    }

    // Operation guard to ignore stale results from previous requests
    const opId = ++activeOpId;

    setProcessing(true);
    updateButtonsState();

    setStatus('Recognizing...', 'processing');
    showText('');
    showAnswer('');

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
    currentRequestId = requestId;

    try {
        const transcribeRes = await window.api.assistant.transcribeOnly({
            arrayBuffer,
            mime: 'audio/wav',
            filename: `last_${seconds}s.wav`,
            audioSeconds: seconds,
        });
        // If a newer operation started while transcribing, ignore this result
        if (opId !== activeOpId) {
            setStatus('Ready', 'ready');
            setProcessing(false);
            updateButtonsState();
            return;
        }
        if (!transcribeRes.ok) {
            setStatus('Error', 'error');
            showAnswer('Error: ' + transcribeRes.error);
            setProcessing(false);
            updateButtonsState();
            return;
        }
        const text = transcribeRes.text;

        showText(text);

        setStatus('Sending to LLM...', 'sending');

        try {
            (window.api.assistant as any).offStreamTranscript?.();
            (window.api.assistant as any).offStreamDelta?.();
            (window.api.assistant as any).offStreamDone?.();
            (window.api.assistant as any).offStreamError?.();
        } catch {
        }

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
            if (btnStop) btnStop.classList.add('hidden');
            currentRequestId = null;
        });
        window.api.assistant.onStreamError((_e: unknown, p: { requestId?: string; error: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            const msg = (p.error || '').toString();
            if (msg.toLowerCase().includes('aborted')) {
                setStatus('Done', 'ready');
            } else {
                setStatus('Error', 'error');
                showAnswer('Error: ' + p.error);
            }
            setProcessing(false);
            updateButtonsState();
            if (btnStop) btnStop.classList.add('hidden');
            currentRequestId = null;
        });

        if (btnStop) btnStop.classList.remove('hidden');
        await window.api.assistant.askChat({ text, requestId });

    } catch (error) {
        setStatus('Error', 'error');
        showAnswer('Error: ' + (error as any)?.message || String(error));
        setProcessing(false);
        updateButtonsState();
    }
}

async function handleTextSend(text: string) {
    logger.info('ui', 'Handle text send', { 
        textLength: text.length,
        inputText: text 
    });
    setProcessing(true);
    updateButtonsState();

    showText(text);
    showAnswer('');

    const textInput = document.getElementById('textInput') as HTMLTextAreaElement | null;
    if (textInput) {
        textInput.value = '';
    }

    const requestId = `text-send-${Date.now()}`;
    currentRequestId = requestId;

    try {
        setStatus('Sending to LLM...', 'sending');

        try {
            (window.api.assistant as any).offStreamTranscript?.();
            (window.api.assistant as any).offStreamDelta?.();
            (window.api.assistant as any).offStreamDone?.();
            (window.api.assistant as any).offStreamError?.();
        } catch {
        }

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
            if (btnStop) btnStop.classList.add('hidden');
            currentRequestId = null;
        });
        window.api.assistant.onStreamError((_e: unknown, p: { requestId?: string; error: string }) => {
            if (!p || (p.requestId && p.requestId !== requestId)) return;
            const msg = (p.error || '').toString();
            if (msg.toLowerCase().includes('aborted')) {
                setStatus('Done', 'ready');
            } else {
                setStatus('Error', 'error');
                showAnswer('Error: ' + p.error);
            }
            setProcessing(false);
            updateButtonsState();
            if (btnStop) btnStop.classList.add('hidden');
            currentRequestId = null;
        });

        if (btnStop) btnStop.classList.remove('hidden');
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
    // Initialize font size functionality
    initializeFontSize();
    
    // Add wheel event listener for font size control
    document.addEventListener('wheel', handleFontSizeWheel, { passive: false });
    
    // Initialize stream mode elements
    streamModeContainer = document.getElementById('streamResultsSection');
    streamResults = document.getElementById('streamResultsTextarea') as HTMLTextAreaElement | null;
    btnSendStream = document.getElementById('btnSendStreamText') as HTMLButtonElement | null;

    // Enable/disable send button based on textarea content
    try {
        if (streamResults && btnSendStream) {
            const updateStreamSendState = () => {
                btnSendStream!.disabled = !(streamResults!.value.trim().length > 0) || state.isProcessing;
            };
            streamResults.addEventListener('input', updateStreamSendState);
            updateStreamSendState();
        }
    } catch {}
    
    // Load logo
    const logoElement = document.getElementById('logo') as HTMLImageElement;
    if (logoElement) {
        try {
            // Try to load logo from brand folder
            logoElement.src = '../../brand/logo.png';
            logoElement.onerror = () => {
                // Fallback: try alternative path
                logoElement.src = 'brand/logo.png';
                logoElement.onerror = () => {
                    // Final fallback: hide logo if not found
                    logoElement.style.display = 'none';
                };
            };
        } catch (error) {
            console.warn('Could not load logo:', error);
            logoElement.style.display = 'none';
        }
    }

    const {durations, durationHotkeys} = await window.api.settings.get();
    if (Array.isArray(durations) && durations.length) {
        try {
            (state as any).durationSec = Math.max(...durations);
        } catch {
        }
    }
    initControls({
        durations,
        onRecordToggle: async (shouldRecord) => {
            if (shouldRecord) await startRecording(); else await stopRecording();
        },
        onDurationChange: (sec) => {
            handleAskWindow(sec);
        },
        onTextSend: (text) => {
            handleTextSend(text);
        },
    });

    // Toggle input button
    try {
        await updateToggleButtonLabel();
        const btn = document.getElementById('btnToggleInput') as HTMLButtonElement | null;
        if (btn) {
            btn.addEventListener('click', async () => {
                if (state.isProcessing) return;
                try {
                    const s = await window.api.settings.get();
                    const cur = (s.audioInputType || 'microphone') as 'microphone' | 'system';
                    const next: 'microphone' | 'system' = cur === 'microphone' ? 'system' : 'microphone';
                    let preStream: MediaStream | undefined;
                    if (state.isRecording && next === 'system') {
                        try {
                            // Hint OS to prepare loopback before capture (do not await)
                            try { (window as any).api?.loopback?.enable?.(); } catch {}
                            const disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
                            const audioTracks = disp.getAudioTracks();
                            const sysTrack = audioTracks[0];
                            if (sysTrack) {
                                // Keep original system track alive for future hotkey reuse
                                try { if (persistentSystemAudioTrack && persistentSystemAudioTrack !== sysTrack) persistentSystemAudioTrack.stop(); } catch {}
                                persistentSystemAudioTrack = sysTrack;
                                try { persistentSystemAudioTrack.onended = () => { persistentSystemAudioTrack = null; }; } catch {}
                                // Use a clone for the active recorder, so stopping recording won't kill the persisted one
                                const clone = sysTrack.clone();
                                preStream = new MediaStream([clone]);
                            } else {
                                preStream = new MediaStream(audioTracks);
                            }
                            disp.getVideoTracks().forEach((t) => t.stop());
                        } catch (err) {
                            console.error('System audio capture cancelled/failed', err);
                            setStatus('System audio requires a user selection', 'error');
                            return;
                        }
                    }
                    await switchAudioInput(next, { preStream, gesture: true });
                } catch (e) {
                    console.error('Toggle input failed', e);
                }
            });
        }
    } catch {}

    // Проставим подписи хоткеев на кнопках
    try {
        const durationsEl = document.getElementById('durations') as HTMLDivElement | null;
        if (durationsEl && durationHotkeys) {
            const buttons = durationsEl.querySelectorAll('button');
            buttons.forEach((btn) => {
                const sec = Number((btn as HTMLButtonElement).dataset['sec'] || '0');
                const key = (durationHotkeys as any)[sec];
                if (key) {
                    // remove old hint if exists
                    const old = btn.querySelector('.hk');
                    if (old) old.remove();
                    const label = document.createElement('span');
                    label.className = 'hk text-xs text-gray-400';
                    label.textContent = `Ctrl-${String(key).toUpperCase()}`;
                    btn.appendChild(label);
                }
            });
        }
    } catch {}

    // Подписка на глобальные хоткеи
    window.api.hotkeys.onDuration((_e: unknown, payload: { sec: number }) => {
        try {
            handleAskWindow(payload.sec);
        } catch {}
    });

    // Хоткей переключения входа
    try {
        window.api.hotkeys.onToggleInput(async () => {
            if (state.isProcessing) return;
            try {
                const s = await window.api.settings.get();
                const cur = (s.audioInputType || 'microphone') as 'microphone' | 'system';
                const next: 'microphone' | 'system' = cur === 'microphone' ? 'system' : 'microphone';
                let preStream: MediaStream | undefined;
                // If we have a persisted system track from a previous user gesture, reuse it without prompting
                if (state.isRecording && next === 'system' && persistentSystemAudioTrack && persistentSystemAudioTrack.readyState === 'live') {
                    try {
                        // Enable loopback in background
                        try { (window as any).api?.loopback?.enable?.(); } catch {}
                        const clone = persistentSystemAudioTrack.clone();
                        preStream = new MediaStream([clone]);
                    } catch {}
                }
                // Fallback: try Electron desktopCapturer-based capture without gesture
                if (state.isRecording && next === 'system' && !preStream) {
                    try {
                        const sourceId = await (window as any).api?.media?.getPrimaryDisplaySourceId?.();
                        const gumConstraints: any = sourceId ? {
                            audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
                            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
                        } : {
                            audio: { mandatory: { chromeMediaSource: 'desktop' } },
                            video: { mandatory: { chromeMediaSource: 'desktop' } },
                        };
                        const stream = await navigator.mediaDevices.getUserMedia(gumConstraints);
                        const audioTracks = stream.getAudioTracks();
                        const sysTrack = audioTracks[0] || null;
                        if (sysTrack) {
                            try { if (persistentSystemAudioTrack && persistentSystemAudioTrack !== sysTrack) persistentSystemAudioTrack.stop(); } catch {}
                            persistentSystemAudioTrack = sysTrack;
                            try { persistentSystemAudioTrack.onended = () => { persistentSystemAudioTrack = null; }; } catch {}
                            const clone = sysTrack.clone();
                            preStream = new MediaStream([clone]);
                        }
                        // Stop video tracks immediately
                        try { stream.getVideoTracks().forEach(t => t.stop()); } catch {}
                    } catch (e) {
                        console.error('desktopCapturer getUserMedia fallback failed', e);
                    }
                }
                await switchAudioInput(next, { preStream, gesture: false });
            } catch (e) {
                console.error('Toggle input via hotkey failed', e);
            }
        });
    } catch {}

    btnStop = document.getElementById('btnStopStream') as HTMLButtonElement | null;
    if (btnStop) {
        btnStop.addEventListener('click', async () => {
            if (!currentRequestId) { btnStop?.classList.add('hidden'); return; }
            try {
                await window.api.assistant.stopStream({ requestId: currentRequestId });
            } catch (e) {
                console.error('Stop stream error', e);
            } finally {
                setStatus('Ready', 'ready');
                setProcessing(false);
                updateButtonsState();
                btnStop?.classList.add('hidden');
                currentRequestId = null;
            }
        });
    }

    // Stream mode event handlers
    if (btnSendStream) {
        btnSendStream.addEventListener('click', async () => {
            await handleStreamTextSend();
        });
    }

    // Stream send hotkey (dynamic)
    try {
        const settings = await window.api.settings.get();
        currentStreamSendHotkey = settings.streamSendHotkey || '~';
    } catch (error) {
        console.error('Error reading initial stream send hotkey:', error);
    }

    // Helper to make tilde/backquote robust across layouts
    function normalizeConfigHotkeyKey(k: string): string {
        const lower = String(k || '').toLowerCase();
        if (lower === '~' || lower === '`') return 'backquote';
        return lower;
    }
    function eventKeyId(e: KeyboardEvent): string {
        const code = (e.code || '');
        const key = String(e.key || '').toLowerCase();
        if (code === 'Backquote') return 'backquote';
        if (key === 'dead' && code === 'Backquote') return 'backquote';
        return key;
    }

    // Single keydown listener that uses a mutable hotkey value
    document.addEventListener('keydown', async (e) => {
        try {
            const pressed = eventKeyId(e);
            const targetKey = normalizeConfigHotkeyKey(currentStreamSendHotkey || '~');
            if (e.ctrlKey && pressed === targetKey && isStreamMode) {
                e.preventDefault();
                await handleStreamTextSend();
            }
        } catch {}
    });

    // React to settings changes dispatched from SettingsPanel
    window.addEventListener('xexamai:settings-changed' as any, async (ev: any) => {
        try {
            const { key, value } = ev?.detail || {};
            if (key === 'streamSendHotkey') {
                currentStreamSendHotkey = value || '~';
            }
            if (key === 'streamMode') {
                await updateStreamModeVisibility();
            }
            if (key === 'audioInputType') {
                currentAudioInputType = (value === 'system' ? 'system' : 'microphone');
            }
        } catch {}
    });

    // Initialize stream mode visibility after all elements are ready
    await updateStreamModeVisibility();

    // Initialize settings panels for each tab
    const settingsGeneralPanel = document.getElementById('settingsGeneralPanel');
    const settingsAiPanel = document.getElementById('settingsAiPanel');
    const settingsAudioPanel = document.getElementById('settingsAudioPanel');
    const settingsHotkeysPanel = document.getElementById('settingsHotkeysPanel');

    if (settingsGeneralPanel) {
        new SettingsPanel(settingsGeneralPanel, {
            panelType: 'general',
            onDurationsChange: (newDurations) => {
                updateDurations(newDurations, (sec) => {
                    handleAskWindow(sec);
                });
                try {
                    (state as any).durationSec = Math.max(...newDurations);
                } catch {
                }
                // refresh hints after durations changed: read current hotkeys and repaint
                window.api.settings.get().then((s) => {
                    const durationsEl = document.getElementById('durations') as HTMLDivElement | null;
                    if (durationsEl) {
                        const buttons = durationsEl.querySelectorAll('button');
                        buttons.forEach((btn) => {
                            const old = btn.querySelector('.hk');
                            if (old) old.remove();
                            const sec = Number((btn as HTMLButtonElement).dataset['sec'] || '0');
                            const key = (s.durationHotkeys as any)?.[sec];
                            if (key) {
                                const label = document.createElement('span');
                                label.className = 'hk text-xs text-gray-400';
                                label.textContent = `Ctrl-${String(key).toUpperCase()}`;
                                btn.appendChild(label);
                            }
                        });
                    }
                }).catch(() => {});
            },
            onHotkeysChange: (map) => {
                const durationsEl = document.getElementById('durations') as HTMLDivElement | null;
                if (!durationsEl) return;
                const buttons = durationsEl.querySelectorAll('button');
                buttons.forEach((btn) => {
                    const old = btn.querySelector('.hk');
                    if (old) old.remove();
                    const sec = Number((btn as HTMLButtonElement).dataset['sec'] || '0');
                    const key = (map as any)[sec];
                    if (key) {
                        const label = document.createElement('span');
                        label.className = 'hk text-xs text-gray-400';
                        label.textContent = `Ctrl-${String(key).toUpperCase()}`;
                        btn.appendChild(label);
                    }
                });
            },
            onSettingsChange: async () => {
                // Update stream mode visibility when settings change
                await updateStreamModeVisibility();
            }
        });
    }

    // Initialize other settings panels
    if (settingsAiPanel) {
        new SettingsPanel(settingsAiPanel, { 
            panelType: 'ai',
            onSettingsChange: async () => {
                // Update stream mode visibility when settings change
                await updateStreamModeVisibility();
            }
        });
    }
    if (settingsAudioPanel) {
        new SettingsPanel(settingsAudioPanel, { panelType: 'audio' });
    }
    if (settingsHotkeysPanel) {
        new SettingsPanel(settingsHotkeysPanel, { panelType: 'hotkeys' });
    }

    // Settings sub-tabs navigation
    const settingsGeneralTab = document.getElementById('settingsGeneralTab');
    const settingsAiTab = document.getElementById('settingsAiTab');
    const settingsAudioTab = document.getElementById('settingsAudioTab');
    const settingsHotkeysTab = document.getElementById('settingsHotkeysTab');

    function switchSettingsTab(activeTab: string) {
        // Hide all panels
        [settingsGeneralPanel, settingsAiPanel, settingsAudioPanel, settingsHotkeysPanel].forEach(panel => {
            if (panel) panel.classList.add('hidden');
        });
        
        // Remove active class from all tabs
        [settingsGeneralTab, settingsAiTab, settingsAudioTab, settingsHotkeysTab].forEach(tab => {
            if (tab) tab.classList.remove('active');
        });

        // Show active panel and tab
        const activePanel = document.getElementById(`settings${activeTab}Panel`);
        const activeTabElement = document.getElementById(`settings${activeTab}Tab`);
        if (activePanel) activePanel.classList.remove('hidden');
        if (activeTabElement) activeTabElement.classList.add('active');
    }

    // Add event listeners for settings sub-tabs
    if (settingsGeneralTab) {
        settingsGeneralTab.addEventListener('click', () => switchSettingsTab('General'));
    }
    if (settingsAiTab) {
        settingsAiTab.addEventListener('click', () => switchSettingsTab('Ai'));
    }
    if (settingsAudioTab) {
        settingsAudioTab.addEventListener('click', () => switchSettingsTab('Audio'));
    }
    if (settingsHotkeysTab) {
        settingsHotkeysTab.addEventListener('click', () => switchSettingsTab('Hotkeys'));
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

main().catch((e) => {
    console.error(e);
    setStatus('Initialization error', 'error');
});

async function recordFromStream(stream: MediaStream, seconds: number, mime: string): Promise<Blob> {
    return new Promise<Blob>((resolve) => {
        const rec = new MediaRecorder(stream, {mimeType: mime});
        const chunks: Blob[] = [];
        rec.addEventListener('dataavailable', (ev) => {
            if (ev.data && ev.data.size > 0) chunks.push(ev.data);
        });
        rec.addEventListener('stop', () => {
            resolve(new Blob(chunks, {type: mime}));
        });
        rec.start();
        setTimeout(() => rec.stop(), Math.max(250, seconds * 1000));
    });
}

// Font size management functions
function getCurrentFontSize(): number {
    const saved = localStorage.getItem(FONT_SIZE_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_FONT_SIZE;
}

function setFontSize(size: number): void {
    const clampedSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
    localStorage.setItem(FONT_SIZE_KEY, clampedSize.toString());
    document.documentElement.style.setProperty('--answer-font-size', `${clampedSize}px`);
    
    // Show temporary notification
    showFontSizeNotification(clampedSize);
}

function showFontSizeNotification(size: number): void {
    // Remove existing notification if any
    const existing = document.getElementById('font-size-notification');
    if (existing) {
        existing.remove();
    }
    
    // Create notification element
    const notification = document.createElement('div');
    notification.id = 'font-size-notification';
    notification.textContent = `Font size: ${size}px`;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 8px 16px;
        border-radius: 4px;
        font-size: 12px;
        z-index: 10000;
        pointer-events: none;
        transition: opacity 0.3s ease;
    `;
    
    document.body.appendChild(notification);
    
    // Fade out after 2 seconds
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
    }, 2000);
}

function initializeFontSize(): void {
    const currentSize = getCurrentFontSize();
    setFontSize(currentSize);
}

function handleFontSizeWheel(event: WheelEvent): void {
    if (!event.ctrlKey) return;
    
    event.preventDefault();
    
    const currentSize = getCurrentFontSize();
    const delta = event.deltaY > 0 ? -1 : 1;
    const newSize = currentSize + delta;
    
    setFontSize(newSize);
}

