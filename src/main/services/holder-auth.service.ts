import ElectronStore from 'electron-store';
import {Connection, Keypair, PublicKey} from '@solana/web3.js';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QRCodeSVG} from 'qrcode.react';
import {logger} from './logger.service';
import {HolderChallengeInfo, HolderStatus, HolderVerificationResult} from '../../shared/ipc';

type HolderChallenge = HolderChallengeInfo & { id: string };

type HolderStoreSchema = {
    wallet?: string;
    lastVerified?: string;
    challenge?: HolderChallenge;
    lastBalanceCheck?: string;
    hasToken?: boolean;
    tokenBalance?: string;
};

const SOLANA_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const TOKEN_MINT = new PublicKey('D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG');
const SOLANA_PAY_RECIPIENT = new PublicKey('BmYL54r18aT779iLeLWbbp1ygYAQcmMpWuKcq4mJErqP');
const VERIFICATION_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const CHALLENGE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function toIso(timestamp: number): string {
    return new Date(timestamp).toISOString();
}

function parseIso(input?: string): number | null {
    if (!input) return null;
    const ts = Date.parse(input);
    return Number.isFinite(ts) ? ts : null;
}

function serializeAmount(raw: bigint, decimals: number): string {
    if (raw === 0n) return '0';
    if (decimals <= 0) return raw.toString();
    const base = BigInt(10) ** BigInt(decimals);
    const integer = raw / base;
    const fraction = raw % base;
    if (fraction === 0n) return integer.toString();
    const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${integer.toString()}.${fractionStr}`;
}

export class HolderAuthService {
    private readonly store: any;
    private readonly connection = new Connection(SOLANA_RPC_ENDPOINT, {commitment: 'confirmed'});
    private readonly tokenMint = TOKEN_MINT;
    private readonly recipient = SOLANA_PAY_RECIPIENT;

    constructor() {
        this.store = new ElectronStore<HolderStoreSchema>({name: 'holder-auth'});
    }

    public async getStatus(options: { refreshBalance?: boolean } = {}): Promise<HolderStatus> {
        const wallet = this.store.get('wallet');
        const lastVerified = this.store.get('lastVerified');
        const storedChallenge = this.store.get('challenge');
        const needsSignature = this.requiresSignature(lastVerified);

        let activeChallenge: HolderChallenge | null = storedChallenge && !this.isChallengeExpired(storedChallenge)
            ? storedChallenge
            : null;

        const status: HolderStatus = {
            isAuthorized: false,
            wallet,
            lastVerified,
            needsSignature,
        };

        if (needsSignature || !wallet) {
            activeChallenge = this.ensureChallenge(activeChallenge);
            status.needsSignature = true;
            status.challenge = this.toChallengeInfo(activeChallenge);
            return status;
        }

        status.checkingBalance = true;
        const owner = new PublicKey(wallet);
        const maxAttempts = 3;
        let lastError: string | null = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const {hasToken, amount} = await this.fetchTokenBalance(owner);
                status.isAuthorized = hasToken;
                status.tokenBalance = amount;
                this.store.set('hasToken', hasToken);
                this.store.set('tokenBalance', amount);
                this.store.set('lastBalanceCheck', toIso(Date.now()));

                if (!hasToken) {
                    status.error = 'Token balance is zero';
                    status.needsSignature = true;
                    activeChallenge = this.ensureChallenge(activeChallenge);
                    status.challenge = this.toChallengeInfo(activeChallenge);
                    this.store.delete('hasToken');
                    this.store.delete('tokenBalance');
                    this.store.delete('lastBalanceCheck');
                } else {
                    status.needsSignature = false;
                    status.challenge = undefined;
                    this.store.delete('challenge');
                }

                status.checkingBalance = false;
                logger.info('holder', 'Holder status refreshed', {
                    wallet,
                    hasToken: status.isAuthorized,
                    attempt,
                });
                return status;
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
                logger.warn('holder', 'Failed to refresh holder balance', { wallet, attempt, error: lastError });
                if (attempt < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
                }
            }
        }

        status.checkingBalance = false;
        status.isAuthorized = false;
        status.needsSignature = true;
        status.error = lastError || 'Failed to check token balance';
        activeChallenge = this.ensureChallenge(activeChallenge);
        status.challenge = this.toChallengeInfo(activeChallenge);
        this.store.delete('hasToken');
        this.store.delete('tokenBalance');
        this.store.delete('lastBalanceCheck');
        logger.info('holder', 'Holder status fallback to re-verify', {
            wallet,
            error: status.error,
        });
        return status;
    }

    public async createChallenge(): Promise<HolderStatus> {
        const challenge = this.ensureChallenge(this.store.get('challenge'));
        const wallet = this.store.get('wallet');
        const lastVerified = this.store.get('lastVerified');
        return {
            isAuthorized: false,
            wallet,
            lastVerified,
            needsSignature: true,
            challenge: this.toChallengeInfo(challenge),
        };
    }

    public async verifySignature(signatureRaw: string): Promise<HolderVerificationResult> {
        const currentChallenge = this.store.get('challenge');
        if (!currentChallenge || this.isChallengeExpired(currentChallenge)) {
            return {
                ok: false,
                error: 'Verification challenge expired. Please request a new link.',
            };
        }

        const signature = this.sanitizeSignature(signatureRaw);
        if (!signature) {
            return {
                ok: false,
                error: 'Signature is required.',
            };
        }

        logger.info('holder', 'Verifying holder signature', { signature });

        const tx = await this.connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
        }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('holder', 'Failed to fetch transaction for verification', { signature, error: message });
            throw new Error('Failed to fetch transaction from Solana RPC.');
        });

        if (!tx) {
            logger.warn('holder', 'Transaction not found for signature', { signature });
            return {
                ok: false,
                error: 'Transaction not found. Ensure the signature is confirmed on-chain.',
            };
        }

        const reference = currentChallenge.reference;
        const keys = this.collectAccountKeys(tx);
        if (!keys.includes(reference)) {
            logger.warn('holder', 'Transaction does not include challenge reference', { signature, reference });
            return {
                ok: false,
                error: 'Signature does not match the current challenge.',
            };
        }

        const wallet = keys[0];
        if (!wallet) {
            logger.warn('holder', 'Failed to determine wallet from transaction', { signature });
            return {
                ok: false,
                error: 'Unable to determine wallet from transaction.',
            };
        }

        const owner = new PublicKey(wallet);
        const {hasToken, amount} = await this.fetchTokenBalance(owner);
        if (!hasToken) {
            logger.warn('holder', 'Wallet does not hold required token', { wallet });
            return {
                ok: false,
                error: 'Token balance is zero.',
            };
        }

        const nowIso = toIso(Date.now());
        this.store.set('wallet', wallet);
        this.store.set('lastVerified', nowIso);
        this.store.set('hasToken', true);
        this.store.set('tokenBalance', amount);
        this.store.set('lastBalanceCheck', nowIso);
        this.store.delete('challenge');

        logger.info('holder', 'Holder verified successfully', {
            wallet,
            amount,
            signature,
        });

        return {
            ok: true,
            wallet,
            lastVerified: nowIso,
            message: `Token balance: ${amount}`,
        };
    }

    public async reset(): Promise<void> {
        this.store.clear();
    }

    private requiresSignature(lastVerified?: string): boolean {
        const ts = parseIso(lastVerified);
        if (!ts) return true;
        return Date.now() - ts >= VERIFICATION_TTL_MS;
    }

    private ensureChallenge(challenge?: HolderChallenge | null): HolderChallenge {
        if (challenge && !this.isChallengeExpired(challenge)) {
            return challenge;
        }
        const referenceKey = Keypair.generate().publicKey;
        const createdAt = Date.now();
        const expiresAt = createdAt + CHALLENGE_TTL_MS;
        const id = `holder-${createdAt}`;
        const deeplink = this.buildDeeplink(referenceKey, id);
        const qrSvg = this.renderQrSvg(deeplink);
        const freshChallenge: HolderChallenge = {
            id,
            reference: referenceKey.toBase58(),
            deeplink,
            createdAt: toIso(createdAt),
            expiresAt: toIso(expiresAt),
            qrSvg,
        };
        this.store.set('challenge', freshChallenge);
        return freshChallenge;
    }

    private isChallengeExpired(challenge: HolderChallenge): boolean {
        const expiresAt = parseIso(challenge.expiresAt);
        if (!expiresAt) return true;
        return Date.now() > expiresAt;
    }

    private toChallengeInfo(challenge: HolderChallenge): HolderChallengeInfo {
        return {
            deeplink: challenge.deeplink,
            reference: challenge.reference,
            createdAt: challenge.createdAt,
            expiresAt: challenge.expiresAt,
            qrSvg: challenge.qrSvg,
        };
    }

    private renderQrSvg(value: string): string {
        try {
            const element = React.createElement(QRCodeSVG, {
                value,
                size: 256,
                includeMargin: true,
                level: 'Q',
                bgColor: '#ffffff',
                fgColor: '#000000',
            });
            return renderToStaticMarkup(element);
        } catch (error) {
            logger.error('holder', 'Failed to render QR code', { error: error instanceof Error ? error.message : String(error) });
            return '';
        }
    }

    private buildDeeplink(reference: PublicKey, memoId: string): string {
        const params = new URLSearchParams();
        params.set('amount', '0');
        params.set('reference', reference.toBase58());
        params.set('label', 'xexamai Holder Verification');
        params.set('message', 'Sign to verify D1zY7HRVE4cz2TctSrckwBKnUzhCkitUekgTf6bhXsTG ownership');
        params.set('memo', memoId);
        params.set('cluster', 'mainnet-beta');
        params.set('spl-token', this.tokenMint.toBase58());
        return `solana:${this.recipient.toBase58()}?${params.toString()}`;
    }

    private sanitizeSignature(signature: string | undefined | null): string | null {
        if (!signature) return null;
        const trimmed = signature.trim();
        if (!trimmed) return null;
        if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(trimmed)) {
            return null;
        }
        return trimmed;
    }

    private collectAccountKeys(tx: any): string[] {
        const keys: string[] = [];
        const message = tx.transaction.message;
        if (message?.staticAccountKeys) {
            for (const key of message.staticAccountKeys) {
                keys.push(key.toBase58());
            }
        } else if (message?.accountKeys) {
            for (const key of message.accountKeys) {
                keys.push(key.toBase58());
            }
        }
        const meta = tx.meta;
        if (meta?.loadedAddresses) {
            const {readonly, writable} = meta.loadedAddresses;
            if (Array.isArray(readonly)) {
                for (const key of readonly) keys.push(key.toBase58());
            }
            if (Array.isArray(writable)) {
                for (const key of writable) keys.push(key.toBase58());
            }
        }
        return keys;
    }

    private async fetchTokenBalance(owner: PublicKey): Promise<{ hasToken: boolean; amount: string }> {
        const response = await this.connection.getParsedTokenAccountsByOwner(owner, {mint: this.tokenMint});
        let totalRaw = 0n;
        let decimals = 0;
        for (const entry of response.value) {
            const tokenAmount = entry?.account?.data?.parsed?.info?.tokenAmount;
            if (!tokenAmount) continue;
            const rawStr = tokenAmount.amount as string | undefined;
            const raw = rawStr ? BigInt(rawStr) : 0n;
            const entryDecimals = Number(tokenAmount.decimals ?? 0);
            if (entryDecimals > decimals) {
                decimals = entryDecimals;
            }
            totalRaw += raw;
        }
        const hasToken = totalRaw > 0n;
        const amount = serializeAmount(totalRaw, decimals);
        return {hasToken, amount};
    }
}

export const holderAuthService = new HolderAuthService();
