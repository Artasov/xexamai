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
    mainWindow = createMainWindow();
    registerSttIpc();
    registerSettingsIpc();
    registerWindowIpc();
}

function registerWindowIpc() {
    ipcMain.handle('window:minimize', () => {
        if (mainWindow) {
            mainWindow.minimize();
        }
    });

    ipcMain.handle('window:close', () => {
        if (mainWindow) {
            mainWindow.close();
        }
    });
}

app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.on('ready', onReady);
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) onReady();
});
