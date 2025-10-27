import {contextBridge} from 'electron';
import {AssistantAPI} from '../shared/ipc';
import {createAssistantBridge} from './api/assistant';
import {createGoogleBridge} from './api/google';
import {createSettingsBridge} from './api/settings';
import {createScreenBridge} from './api/screen';
import {createHotkeysBridge} from './api/hotkeys';
import {createWindowControlsBridge} from './api/windowControls';
import {createLoopbackBridge} from './api/loopback';
import {createHolderBridge} from './api/holder';
import {createMediaBridge} from './api/media';
import {createLoggerBridge} from './api/logger';

const api: AssistantAPI = {
    assistant: createAssistantBridge(),
    google: createGoogleBridge(),
    settings: createSettingsBridge(),
    screen: createScreenBridge(),
    hotkeys: createHotkeysBridge(),
    window: createWindowControlsBridge(),
    loopback: createLoopbackBridge(),
    holder: createHolderBridge(),
    media: createMediaBridge(),
    log: createLoggerBridge(),
};

declare global {
    interface Window {
        api: AssistantAPI;
    }
}

try {
    console.info('[preload] exposing api bridge');
    contextBridge.exposeInMainWorld('api', api);
    console.info('[preload] bridge ready');
} catch (error) {
    console.error('[preload] failed to expose bridge', error);
}
