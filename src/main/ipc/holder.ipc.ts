import {ipcMain} from 'electron';
import {holderAuthService} from '../services/holder-auth.service';
import {IPCChannels, HolderStatus, HolderVerificationResult} from '../../shared/ipc';
import {logger} from '../services/logger.service';

function errorStatus(message: string): HolderStatus {
    return {
        isAuthorized: false,
        needsSignature: true,
        error: message,
    };
}

export function registerHolderIpc() {
    ipcMain.handle(IPCChannels.HolderGetStatus, async (_event, options?: { refreshBalance?: boolean }): Promise<HolderStatus> => {
        try {
            return await holderAuthService.getStatus(options || {});
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('holder', 'Failed to fetch holder status', { error: message });
            return errorStatus(message || 'Failed to fetch holder status.');
        }
    });

    ipcMain.handle(IPCChannels.HolderCreateChallenge, async (): Promise<HolderStatus> => {
        try {
            return await holderAuthService.createChallenge();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('holder', 'Failed to create verification challenge', { error: message });
            return errorStatus(message || 'Failed to create verification challenge.');
        }
    });

    ipcMain.handle(IPCChannels.HolderVerifySignature, async (_event, signature: string): Promise<HolderVerificationResult> => {
        try {
            return await holderAuthService.verifySignature(signature);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('holder', 'Holder verification failed', { error: message });
            return {
                ok: false,
                error: message || 'Holder verification failed.',
            };
        }
    });

    ipcMain.handle(IPCChannels.HolderReset, async (): Promise<void> => {
        try {
            await holderAuthService.reset();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('holder', 'Failed to reset holder state', { error: message });
            throw error;
        }
    });
}
