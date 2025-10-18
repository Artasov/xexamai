import {desktopCapturer} from 'electron';
import {AssistantAPI} from '../../shared/ipc';

export function createMediaBridge(): AssistantAPI['media'] {
    return {
        getPrimaryDisplaySourceId: async () => {
            try {
                const dc: any = desktopCapturer as any;
                if (!dc || typeof dc.getSources !== 'function') {
                    return null;
                }
                const sources = await dc.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } as any });
                const primary = sources.find((s: any) => s.display_id === '0') || sources[0];
                return primary?.id || null;
            } catch (error) {
                console.error('Error getting primary display source id:', error);
                return null;
            }
        },
    };
}
