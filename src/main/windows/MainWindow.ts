import {BrowserWindow, shell} from 'electron';
import path from 'node:path';
import {appConfigService} from '../services/app-config.service';

export function createMainWindow(): BrowserWindow {
    const opacity = appConfigService.getWindowOpacity();
    
    const win = new BrowserWindow({
        width: 420,
        height: 780,
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        opacity: opacity / 100,
        icon: path.join(__dirname, '..', '..', '..', 'brand', 'logo.ico'),
        skipTaskbar: true,
        webPreferences: {
            preload: path.join(__dirname, '..', '..', 'preload', 'index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            autoplayPolicy: 'no-user-gesture-required',
            experimentalFeatures: false,
            enableBlinkFeatures: '',
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

    win.setContentProtection(true);
    win.setSkipTaskbar(true);

    win.once('ready-to-show', () => {
        const shouldOpenDevTools = process.env.NODE_ENV === 'development' || 
                                  process.env.OPEN_DEVTOOLS === 'true';
        
        if (shouldOpenDevTools) {
            win.webContents.openDevTools({mode: 'detach'});
        }
        
        win.setContentProtection(true);
        win.setSkipTaskbar(true);
        
        win.show();
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
