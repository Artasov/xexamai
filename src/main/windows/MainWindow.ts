import {BrowserWindow, shell} from 'electron';
import path from 'node:path';
import {appConfigService} from '../services/app-config.service';

export function createMainWindow(): BrowserWindow {
    const opacity = appConfigService.getWindowOpacity();
    const alwaysOnTop = appConfigService.getAlwaysOnTop();
    const hideApp = appConfigService.getHideApp();
    const initialWidth = appConfigService.getWindowWidth();
    const initialHeight = appConfigService.getWindowHeight();

    const win = new BrowserWindow({
        width: initialWidth,
        height: initialHeight,
        minWidth: 400,
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        opacity: opacity / 100,
        alwaysOnTop: alwaysOnTop,
        icon: path.join(__dirname, '..', '..', '..', 'brand', 'logo.ico'),
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, '..', '..', 'preload', 'index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            autoplayPolicy: 'no-user-gesture-required',
            experimentalFeatures: true,
            enableBlinkFeatures: 'WebGPU',
            disableBlinkFeatures: 'Autofill',
        },
        show: false,
    });

    win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media') {
            callback(true);
        } else {
            callback(false);
        }
    });

    win.webContents.on('did-finish-load', () => {
        win.webContents.executeJavaScript(`
            if (document.documentElement) {
                document.documentElement.setAttribute('autocomplete', 'off');
            }
        `);
    });

    win.setContentProtection(hideApp);
    win.setSkipTaskbar(hideApp);

    win.once('ready-to-show', () => {
        const shouldOpenDevTools = process.env.NODE_ENV === 'development' ||
            process.env.OPEN_DEVTOOLS === 'true';

        if (shouldOpenDevTools) {
            win.webContents.openDevTools({mode: 'detach'});
        }

        win.setContentProtection(hideApp);
        win.setSkipTaskbar(hideApp);

        win.show();

        // On some Windows 11 setups, the initial always-on-top flag can be
        // lost during first paint/show. Re-assert it a few times after show.
        if (alwaysOnTop) {
            try {
                // Immediate re-assert
                win.setAlwaysOnTop(true);
                win.focus();

                // Staggered retries to survive z-order races on startup
                setTimeout(() => {
                    try {
                        win.setAlwaysOnTop(true);
                    } catch {}
                }, 100);

                setTimeout(() => {
                    try {
                        // Use highest practical level where supported
                        // (level parameter is a no-op on some platforms)
                        // @ts-ignore optional level for best-effort behavior
                        win.setAlwaysOnTop(true, 'screen-saver');
                        win.focus();
                    } catch {}
                }, 500);

                setTimeout(() => {
                    try {
                        win.setAlwaysOnTop(true);
                    } catch {}
                }, 1500);
            } catch {}
        }
    });

    win.webContents.once('did-finish-load', () => {
        if (process.env.NODE_ENV === 'development') {
            win.webContents.openDevTools({mode: 'detach'});
        }
    });

    win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));

    win.webContents.setWindowOpenHandler(({url}) => {
        shell.openExternal(url);
        return {action: 'deny'};
    });

    return win;
}
