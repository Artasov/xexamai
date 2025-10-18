import {BrowserWindow, globalShortcut} from 'electron';
import {appConfigService} from './app-config.service';
import {IPCChannels} from '../../shared/ipc';

class HotkeysService {
    private win: BrowserWindow | null = null;

    public init(win: BrowserWindow) {
        this.win = win;
        this.refresh();
    }

    public refresh() {
        try {
            globalShortcut.unregisterAll();
        } catch {}

        const durations = appConfigService.getDurations();
        const map = appConfigService.getDurationHotkeys(durations);
        for (const d of durations) {
            const key = (map as any)[d];
            if (!key) continue;
            const accelerator = `Control+${key.toUpperCase()}`;
            try {
                globalShortcut.register(accelerator, () => {
                    if (this.win && !this.win.isDestroyed()) {
                        try {
                            this.win.webContents.send(IPCChannels.HotkeyDuration, { sec: d });
                        } catch {}
                    }
                });
            } catch {}
        }

        // Toggle input hotkey
        const toggleKey = appConfigService.getToggleInputHotkey();
        if (toggleKey) {
            const accelerator = `Control+${toggleKey.toUpperCase()}`;
            try {
                globalShortcut.register(accelerator, () => {
                    if (this.win && !this.win.isDestroyed()) {
                        try {
                            this.win.webContents.send(IPCChannels.HotkeyToggleInput);
                        } catch {}
                    }
                });
            } catch {}
        }
    }

    public dispose() {
        try {
            globalShortcut.unregisterAll();
        } catch {}
    }
}

export const hotkeysService = new HotkeysService();

