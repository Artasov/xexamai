import {app, BrowserWindow, ipcMain} from 'electron';
import {initMain} from 'electron-audio-loopback';
import {loadEnv} from './services/config.service';
import {registerSttIpc} from './ipc/stt.ipc';
import {registerSettingsIpc} from './ipc/settings.ipc';
import {createMainWindow} from './windows/MainWindow';

loadEnv();
initMain();

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
    registerWindowIpc();
    logger.info('app', 'Application ready');
}

function registerWindowIpc() {
    const {logger} = require('./services/logger.service');
    
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
