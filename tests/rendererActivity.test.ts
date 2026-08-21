import {afterEach, describe, expect, it} from 'vitest';
import {beginRendererActivity, getRendererBusyReason} from '../src/renderer/state/rendererActivity';
import {resetAppState, setRecording} from '../src/renderer/state/appState';

afterEach(() => resetAppState());

describe('renderer update activity gate', () => {
    it('reports renderer-direct work until its lease is released', () => {
        const release = beginRendererActivity('Uploading feedback');
        expect(getRendererBusyReason()).toContain('Uploading feedback');
        release();
        expect(getRendererBusyReason()).toBeNull();
    });

    it('prioritizes active audio capture', () => {
        const release = beginRendererActivity('Uploading feedback');
        setRecording(true);
        expect(getRendererBusyReason()).toContain('audio capture');
        release();
    });
});
