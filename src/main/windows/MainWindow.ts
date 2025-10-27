import {app, BrowserWindow, shell} from 'electron';
import path from 'node:path';
import {appConfigService} from '../services/app-config.service';

export function createMainWindow(): BrowserWindow {
    const opacity = appConfigService.getWindowOpacity();
    const alwaysOnTop = appConfigService.getAlwaysOnTop();
    const hideApp = appConfigService.getHideApp();
    const initialWidth = appConfigService.getWindowWidth();
    const initialHeight = appConfigService.getWindowHeight();

    const isDevelopment = !app.isPackaged || process.env.NODE_ENV === 'development';
    const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? (isDevelopment ? 'http://localhost:5174' : undefined);
    const resolveAssetPath = (...segments: string[]) =>
        app.isPackaged
            ? path.join(process.resourcesPath, ...segments)
            : path.join(process.cwd(), ...segments);

    const appRoot = app.getAppPath();
    const {logger} = require('../services/logger.service');
    logger.debug('app', 'Resolved Electron paths', {
        appRoot,
        preloadCandidate: path.join(appRoot, 'dist', 'main', 'preload.js'),
        rendererCandidate: path.join(appRoot, 'dist', 'renderer', 'index.html'),
        devServerUrl
    });
    const preloadPath = path.join(appRoot, 'dist', 'main', 'preload.js');
    const rendererIndexPath = path.join(appRoot, 'dist', 'renderer', 'index.html');
    const windowIcon = resolveAssetPath(
        'brand',
        process.platform === 'win32' ? 'logo.ico' : 'logo_white.png',
    );

    const win = new BrowserWindow({
        width: initialWidth,
        height: initialHeight,
        minWidth: 400,
        minHeight: 700,
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        opacity: opacity / 100,
        alwaysOnTop: alwaysOnTop,
        icon: windowIcon,
        skipTaskbar: true,
        resizable: true,
        maximizable: true,
        minimizable: true,
        thickFrame: false,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: preloadPath,
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

    try {
        win.setResizable(true);
        win.setMinimumSize(400, 700);
    } catch {}


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

    const loadPromise = devServerUrl
        ? win.loadURL(devServerUrl)
        : win.loadFile(rendererIndexPath);

    loadPromise.catch((error) => {
        console.error('Failed to load renderer', error);
        win.loadFile(rendererIndexPath).catch((fallbackError) => {
            console.error('Fallback renderer load failed', fallbackError);
        });
    });

    win.webContents.setWindowOpenHandler(({url}) => {
        shell.openExternal(url);
        return {action: 'deny'};
    });

    return win;
}
