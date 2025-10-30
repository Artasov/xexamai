import path from 'node:path';
import {app, BrowserWindow, ipcMain, shell} from 'electron';
import {initMain} from 'electron-audio-loopback';
import {loadEnv} from './services/config.service';
import {registerSttIpc} from './ipc/stt.ipc';
import {registerSettingsIpc} from './ipc/settings.ipc';
import {createMainWindow} from './windows/MainWindow';
import {hotkeysService} from './services/hotkeys.service';
import {registerHolderIpc} from './ipc/holder.ipc';
import {IPCChannels, AuthDeepLinkPayload, AuthProvider} from '../shared/ipc';
import {buildOAuthStartUrl} from './services/oauth.service';

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
type PendingAuthPayload = {
    payload: AuthDeepLinkPayload;
    delivered: boolean;
};
const pendingAuthPayloads: PendingAuthPayload[] = [];
const processedDeepLinks = new Set<string>();
let authIpcRegistered = false;

const initialDeepLinks = extractDeepLinksFromArgv(process.argv);
for (const link of initialDeepLinks) {
    handleAuthUrl(link);
}

function notifyAuthPayloads() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const contents = mainWindow.webContents;
    if (!contents || contents.isDestroyed()) return;
    for (const entry of pendingAuthPayloads) {
        if (entry.delivered) continue;
        try {
            contents.send(IPCChannels.AuthDeepLink, entry.payload);
            entry.delivered = true;
        } catch (error) {
            const {logger} = require('./services/logger.service');
            logger.warn('auth', 'Failed to dispatch OAuth payload to renderer', {
                error: error instanceof Error ? error.message : String(error),
            });
            break;
        }
    }
}

function enqueueAuthPayload(payload: AuthDeepLinkPayload) {
    const {logger} = require('./services/logger.service');
    pendingAuthPayloads.push({payload, delivered: false});
    logger.info('auth', 'Queued OAuth payload', {
        kind: payload.kind,
        provider: payload.provider,
    });
    notifyAuthPayloads();
}

function parseAuthPayload(url: string): AuthDeepLinkPayload | null {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'xexamai:') return null;
        if (parsed.hostname !== 'auth') return null;
        if (!parsed.pathname.startsWith('/callback')) return null;
        const rawPayload = parsed.searchParams.get('payload');
        if (!rawPayload) return null;
        const decoded = decodeURIComponent(rawPayload);
        const data = JSON.parse(decoded) as Record<string, unknown>;
        if (data?.app !== 'xexamai') {
            return {
                kind: 'error',
                provider: String(data?.provider ?? 'unknown'),
                error: 'Invalid application payload',
            };
        }
        const provider = String(data?.provider ?? 'unknown');
        if (typeof data?.error === 'string' && data.error.trim().length) {
            return {
                kind: 'error',
                provider,
                error: data.error,
            };
        }
        const tokens = data?.tokens as Record<string, unknown> | undefined;
        if (!tokens || typeof tokens.access !== 'string' || !tokens.access.trim().length) {
            return {
                kind: 'error',
                provider,
                error: 'Missing access token in OAuth payload',
            };
        }
        const refresh = typeof tokens.refresh === 'string' && tokens.refresh.trim().length
            ? tokens.refresh
            : null;
        const user = (data?.user && typeof data.user === 'object') ? data.user as Record<string, unknown> : null;
        return {
            kind: 'success',
            provider,
            tokens: {
                access: tokens.access,
                refresh,
            },
            user,
        };
    } catch (error) {
        const {logger} = require('./services/logger.service');
        logger.error('auth', 'Failed to parse OAuth payload', {
            url,
            error: error instanceof Error ? error.message : String(error),
        });
        return {
            kind: 'error',
            provider: 'unknown',
            error: 'Malformed OAuth payload',
        };
    }
}

function handleAuthUrl(url: string) {
    if (typeof url !== 'string' || !url.trim().startsWith('xexamai://')) return;
    if (processedDeepLinks.has(url)) return;
    processedDeepLinks.add(url);
    const payload = parseAuthPayload(url);
    if (payload) {
        enqueueAuthPayload(payload);
    }
}

function extractDeepLinksFromArgv(argv: string[]): string[] {
    return argv.filter((arg) => typeof arg === 'string' && arg.startsWith('xexamai://'));
}

function registerAuthProtocol() {
    const {logger} = require('./services/logger.service');
    try {
        const protocol = 'xexamai';
        if (process.defaultApp && process.argv.length >= 2) {
            const exePath = process.execPath;
            const appPath = path.resolve(process.argv[1]);
            app.setAsDefaultProtocolClient(protocol, exePath, [appPath]);
        } else {
            app.setAsDefaultProtocolClient(protocol);
        }
        logger.info('auth', 'Registered deep link protocol handler', { protocol });
    } catch (error) {
        logger.warn('auth', 'Failed to register protocol handler', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

function registerAuthIpc() {
    if (authIpcRegistered) return;
    authIpcRegistered = true;
    const {logger} = require('./services/logger.service');

    ipcMain.handle(IPCChannels.AuthStartOAuth, async (_event, provider: AuthProvider) => {
        try {
            const normalized = String(provider).toLowerCase() as AuthProvider;
            const supportedProviders: AuthProvider[] = ['google', 'github', 'discord', 'twitter'];
            if (!supportedProviders.includes(normalized)) {
                throw new Error(`Unsupported OAuth provider: ${provider}`);
            }
            const url = buildOAuthStartUrl(normalized);
            logger.info('auth', 'Launching OAuth in browser', { provider: normalized, url });
            await shell.openExternal(url);
        } catch (error) {
            logger.error('auth', 'Failed to start OAuth flow', {
                provider,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error instanceof Error ? error : new Error(String(error));
        }
    });

    ipcMain.handle(IPCChannels.AuthConsumeDeepLinks, async () => {
        if (!pendingAuthPayloads.length) {
            return [];
        }
        const payloads = pendingAuthPayloads.splice(0, pendingAuthPayloads.length).map((entry) => entry.payload);
        return payloads;
    });
}

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
    
    registerAuthProtocol();
    mainWindow = createMainWindow();
    registerSttIpc();
    registerSettingsIpc();
    registerHolderIpc();
    registerWindowIpc();
    registerAuthIpc();
    if (mainWindow) {
        hotkeysService.init(mainWindow);
        hotkeysService.refresh();
        mainWindow.webContents.on('did-finish-load', () => {
            notifyAuthPayloads();
        });
    }
    notifyAuthPayloads();
    logger.info('app', 'Application ready');
}

function registerWindowIpc() {
    const {logger} = require('./services/logger.service');
    const MIN_WIDTH = 400;
    const MIN_HEIGHT = 500;
    
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

app.on('open-url', (event, url) => {
    event.preventDefault();
    handleAuthUrl(url);
    notifyAuthPayloads();
});

app.on('second-instance', (_event, argv) => {
    const {logger} = require('./services/logger.service');
    logger.info('app', 'Second instance detected, focusing main window');
    try {
        const links = extractDeepLinksFromArgv(argv);
        for (const link of links) {
            handleAuthUrl(link);
        }
    } catch (error) {
        logger.warn('auth', 'Failed to process deep link from second instance', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        notifyAuthPayloads();
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
    notifyAuthPayloads();
});
