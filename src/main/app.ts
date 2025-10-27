import {app, BrowserWindow, ipcMain} from 'electron';
import {initMain} from 'electron-audio-loopback';
import {loadEnv} from './services/config.service';
import {registerSttIpc} from './ipc/stt.ipc';
import {registerSettingsIpc} from './ipc/settings.ipc';
import {createMainWindow} from './windows/MainWindow';
import {hotkeysService} from './services/hotkeys.service';
import {registerHolderIpc} from './ipc/holder.ipc';

// Enable WebGPU in Electron
try {
    app.commandLine.appendSwitch('enable-unsafe-webgpu');
    app.commandLine.appendSwitch('enable-features', 'Vulkan,UseSkiaRenderer,UseDawnBackendForWebGPU');
} catch {}

// Enable high DPI support
try {
    app.commandLine.appendSwitch('high-dpi-support', '1');
} catch {}

loadEnv();
initMain();

// Apply window scale from settings BEFORE creating any windows
try {
    const {appConfigService} = require('./services/app-config.service');
    const windowScale = appConfigService.getWindowScale();
    if (windowScale !== 1.0) {
        app.commandLine.appendSwitch('force-device-scale-factor', windowScale.toString());
        const {logger} = require('./services/logger.service');
        logger.info('app', 'Window scale applied at startup', { scale: windowScale });
    }
} catch (error) {
    console.error('Failed to apply window scale:', error);
}

const isSingleInstance = app.requestSingleInstanceLock();
if (!isSingleInstance) {
    app.quit();
}

let mainWindow: BrowserWindow | null = null;

function onReady() {
    // Инициализируем логгер после готовности app
    const {logger} = require('./services/logger.service');
    
    logger.info('app', 'Application starting', {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron
    });
    
    mainWindow = createMainWindow();
    registerSttIpc();
    registerSettingsIpc();
    registerHolderIpc();
    registerWindowIpc();
    if (mainWindow) {
        hotkeysService.init(mainWindow);
        hotkeysService.refresh();
    }
    logger.info('app', 'Application ready');
}

function registerWindowIpc() {
    const {logger} = require('./services/logger.service');
    const MIN_WIDTH = 400;
    const MIN_HEIGHT = 700;
    
    ipcMain.handle('window:minimize', () => {
        logger.info('ui', 'Window minimize requested');
        if (mainWindow) {
            mainWindow.minimize();
        }
    });

    ipcMain.handle('window:close', () => {
        logger.info('ui', 'Window close requested');
        if (mainWindow) {
            mainWindow.close();
        }
    });

    ipcMain.handle('window:get-bounds', () => {
        if (!mainWindow) return null;
        return mainWindow.getBounds();
    });

    ipcMain.handle('window:set-bounds', (_, bounds: { x: number; y: number; width: number; height: number }) => {
        if (!mainWindow) return;
        const nextWidth = Math.max(MIN_WIDTH, Math.round(bounds.width));
        const nextHeight = Math.max(MIN_HEIGHT, Math.round(bounds.height));
        const nextX = Math.round(bounds.x);
        const nextY = Math.round(bounds.y);
        mainWindow.setBounds({ x: nextX, y: nextY, width: nextWidth, height: nextHeight }, false);
    });

    ipcMain.handle('log:entry', async (_, entry) => {
        logger.log(entry.level, entry.category, entry.message, entry.data);
    });
}

app.on('second-instance', () => {
    const {logger} = require('./services/logger.service');
    logger.info('app', 'Second instance detected, focusing main window');
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.on('ready', onReady);
app.on('window-all-closed', () => {
    const {logger} = require('./services/logger.service');
    logger.info('app', 'All windows closed');
    if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
    const {logger} = require('./services/logger.service');
    logger.info('app', 'Application activated');
    if (BrowserWindow.getAllWindows().length === 0) onReady();
});
