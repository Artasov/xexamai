import {contextBridge} from 'electron';
import {marked} from 'marked';
import {AssistantAPI} from '../shared/ipc';
import {createAssistantBridge} from './api/assistant';
import {createGeminiBridge} from './api/gemini';
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
    gemini: createGeminiBridge(),
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
        marked: {
            parse: (text: string) => string;
        };
    }
}

marked.setOptions({
    breaks: true,
    gfm: true,
});

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('marked', {
    parse: (text: string) => marked.parse(text) as string,
});
