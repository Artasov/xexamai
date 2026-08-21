import type {AudioDeviceInfo} from '@shared/ipc';
import {invokeNative} from '../../bridge/nativeInvoke';
import {settingsStore} from '../../state/settingsStore';

type SelectableAudioDevice = Pick<AudioDeviceInfo, 'id' | 'name'>;

export function resolveLegacyAudioDeviceId(saved: string, devices: SelectableAudioDevice[]): string | null {
    if (!saved || devices.some((device) => device.id === saved)) return null;
    const matches = devices.filter((device) => device.name === saved);
    return matches.length === 1 ? matches[0].id : null;
}

/** One-release migration from old display-name selections to native endpoint ids. */
export async function migrateLegacyAudioDeviceSelection(
    devices: SelectableAudioDevice[],
    savedDeviceId: string,
): Promise<string> {
    const migrated = resolveLegacyAudioDeviceId(savedDeviceId, devices);
    if (!migrated) return savedDeviceId;
    await invokeNative('config_update', {payload: {audioInputDeviceId: migrated}});
    settingsStore.patch({audioInputDeviceId: migrated});
    return migrated;
}
