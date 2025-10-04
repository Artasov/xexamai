let sharedAudioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext {
    if (!sharedAudioCtx || (sharedAudioCtx as any).state === 'closed') {
        sharedAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    try { (sharedAudioCtx as any).resume?.(); } catch {}
    return sharedAudioCtx;
}

export async function blobToWav(input: Blob): Promise<Blob> {
    const arrayBuffer = await input.arrayBuffer();
    const audioCtx = getAudioCtx();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));

    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;

    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numFrames * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const wavBuffer = new ArrayBuffer(totalSize);
    const view = new DataView(wavBuffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');

    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);

    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    const channelData: Float32Array[] = [];
    for (let ch = 0; ch < numChannels; ch++) {
        channelData.push(audioBuffer.getChannelData(ch));
    }

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
            const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            view.setInt16(offset, intSample, true);
            offset += 2;
        }
    }

    return new Blob([wavBuffer], {type: 'audio/wav'});
}

export async function blobsToWav(inputs: Blob[]): Promise<Blob> {
    if (!inputs.length) return new Blob([], { type: 'audio/wav' });
    const audioCtx = getAudioCtx();

    const decoded: AudioBuffer[] = [];
    for (const b of inputs) {
        if (!b || b.size === 0) continue;
        const ab = await b.arrayBuffer();
        const buf = await audioCtx.decodeAudioData(ab.slice(0));
        decoded.push(buf);
    }
    if (!decoded.length) return new Blob([], { type: 'audio/wav' });

    const numChannels = decoded[0].numberOfChannels;
    const sampleRate = decoded[0].sampleRate;
    let totalFrames = 0;
    for (const db of decoded) {
        if (db.numberOfChannels !== numChannels || db.sampleRate !== sampleRate) {
            throw new Error('Inconsistent audio chunks (channels/rate)');
        }
        totalFrames += db.length;
    }

    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = totalFrames * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const wavBuffer = new ArrayBuffer(totalSize);
    const view = new DataView(wavBuffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    const channelData: Float32Array[] = [];
    for (let ch = 0; ch < numChannels; ch++) {
        const arr = new Float32Array(totalFrames);
        let offset = 0;
        for (const db of decoded) {
            arr.set(db.getChannelData(ch), offset);
            offset += db.length;
        }
        channelData.push(arr);
    }

    let wOffset = 44;
    for (let i = 0; i < totalFrames; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
            const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            view.setInt16(wOffset, intSample, true);
            wOffset += 2;
        }
    }

    return new Blob([wavBuffer], { type: 'audio/wav' });
}

export function floatsToWav(channels: Float32Array[], sampleRate: number): Blob {
    const numChannels = Math.max(1, channels.length);
    const numFrames = channels[0]?.length || 0;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numFrames * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const wavBuffer = new ArrayBuffer(totalSize);
    const view = new DataView(wavBuffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = Math.max(-1, Math.min(1, channels[ch][i] || 0));
            const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            view.setInt16(offset, intSample, true);
            offset += 2;
        }
    }
    return new Blob([wavBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
    }
}


