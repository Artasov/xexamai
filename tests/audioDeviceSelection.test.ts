import {describe, expect, it} from 'vitest';
import {resolveLegacyAudioDeviceId} from '../src/renderer/app/audioSession/deviceSelection';

const devices = [
    {id: 'native-a', name: 'USB Microphone'},
    {id: 'native-b', name: 'Built-in Microphone'},
];

describe('audio device selection migration', () => {
    it('migrates a unique legacy display name to its native endpoint id', () => {
        expect(resolveLegacyAudioDeviceId('USB Microphone', devices)).toBe('native-a');
    });

    it('does not guess when a display name is duplicated or the id is already native', () => {
        expect(resolveLegacyAudioDeviceId('native-a', devices)).toBeNull();
        expect(resolveLegacyAudioDeviceId('USB Microphone', [devices[0], {...devices[0], id: 'native-c'}]))
            .toBeNull();
    });
});
