import {useCallback, useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {listen} from '@tauri-apps/api/event';
import {invokeNative} from '../../bridge/nativeInvoke';
import {AsyncListenerSlot} from '../../bridge/asyncListenerSlot';
import type {
    UpdateCheckResult,
    UpdateErrorPayload,
    UpdateMetadata,
    UpdateProgressPayload,
    UpdateStartedPayload,
} from '@shared/generated/NativeBindings';
import {shutdownRendererSession} from '../../app/sessionShutdown';
import {getAppStateSnapshot, subscribeAppState} from '../../state/appState';
import {
    getRendererActivitySnapshot,
    getRendererBusyReason,
    subscribeRendererActivity,
} from '../../state/rendererActivity';

type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';

const clampPercent = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const megabytes = bytes / 1_048_576;
    return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}

function metadataFromCheck(result: UpdateCheckResult): UpdateMetadata | null {
    if (!result.updateAvailable || !result.version) return null;
    return {
        version: result.version,
        currentVersion: result.currentVersion,
        notes: result.notes,
        date: result.date,
        target: result.target || '',
        downloaded: result.downloaded,
    };
}

export function UpdateCenter() {
    const [phase, setPhase] = useState<UpdatePhase>('idle');
    const [metadata, setMetadata] = useState<UpdateMetadata | null>(null);
    const [progress, setProgress] = useState<UpdateProgressPayload | null>(null);
    const [message, setMessage] = useState<string>('');
    const [expanded, setExpanded] = useState(false);
    useSyncExternalStore(subscribeAppState, getAppStateSnapshot, getAppStateSnapshot);
    useSyncExternalStore(subscribeRendererActivity, getRendererActivitySnapshot, getRendererActivitySnapshot);
    const busyReason = getRendererBusyReason();

    const acceptMetadata = useCallback((next: UpdateMetadata) => {
        setMetadata(next);
        setPhase(next.downloaded ? 'downloaded' : 'available');
        setMessage('');
        setExpanded(true);
    }, []);

    useEffect(() => {
        const available = new AsyncListenerSlot<UpdateMetadata>();
        const download = new AsyncListenerSlot<UpdateProgressPayload>();
        const started = new AsyncListenerSlot<UpdateStartedPayload>();
        const failed = new AsyncListenerSlot<UpdateErrorPayload>();

        available.replace(
            (emit) => listen<UpdateMetadata>('update-available', ({payload}) => emit(payload)),
            acceptMetadata,
        );
        download.replace(
            (emit) => listen<UpdateProgressPayload>('update-download-progress', ({payload}) => emit(payload)),
            (payload) => {
                setProgress({...payload, percent: clampPercent(payload.percent)});
                setPhase(payload.percent >= 100 ? 'downloaded' : 'downloading');
                setExpanded(true);
            },
        );
        started.replace(
            (emit) => listen<UpdateStartedPayload>('update-started', ({payload}) => emit(payload)),
            (payload) => {
                setPhase('installing');
                setMessage(`Installing ${payload.version}. The app may close to finish setup.`);
                setExpanded(true);
            },
        );
        failed.replace(
            (emit) => listen<UpdateErrorPayload>('update-error', ({payload}) => emit(payload)),
            (payload) => {
                setPhase('error');
                setMessage(payload.message || 'The update operation failed.');
                setExpanded(true);
            },
        );

        return () => {
            available.clear();
            download.clear();
            started.clear();
            failed.clear();
        };
    }, [acceptMetadata]);

    const run = useCallback(async (action: () => Promise<void>) => {
        try {
            setMessage('');
            await action();
        } catch (error) {
            setPhase('error');
            setMessage(error instanceof Error ? error.message : String(error));
            setExpanded(true);
        }
    }, []);

    const check = useCallback(() => run(async () => {
        setPhase('checking');
        setExpanded(true);
        const result = await invokeNative('check_app_update');
        const next = metadataFromCheck(result);
        if (!next) {
            setMetadata(null);
            setProgress(null);
            setPhase('idle');
            setMessage(`You're up to date (${result.currentVersion}).`);
            return;
        }
        acceptMetadata(next);
    }), [acceptMetadata, run]);

    // Native update events are one-shot. This always-mounted component does a
    // silent signed check so discovery cannot be lost while auth is restoring.
    useEffect(() => {
        let active = true;
        void invokeNative('check_app_update')
            .then((result) => {
                if (!active) return;
                const next = metadataFromCheck(result);
                if (next) acceptMetadata(next);
            })
            .catch(() => {
                // The explicit check button reports errors to the user.
            });
        return () => {
            active = false;
        };
    }, [acceptMetadata]);

    const download = useCallback(() => run(async () => {
        setPhase('downloading');
        setProgress({percent: 0, downloadedBytes: 0, totalBytes: null});
        const next = await invokeNative('download_app_update');
        acceptMetadata({...next, downloaded: true});
    }), [acceptMetadata, run]);

    const install = useCallback(() => run(async () => {
        const beforeShutdown = getRendererBusyReason();
        if (beforeShutdown) throw new Error(beforeShutdown);
        setPhase('installing');
        await shutdownRendererSession('update-install');
        const afterShutdown = getRendererBusyReason();
        if (afterShutdown) throw new Error(afterShutdown);
        await invokeNative('install_app_update');
    }), [run]);

    const discard = useCallback(() => run(async () => {
        await invokeNative('discard_app_update');
        setMetadata(null);
        setProgress(null);
        setMessage('Downloaded update removed.');
        setPhase('idle');
        setExpanded(false);
    }), [run]);

    const progressText = useMemo(() => {
        if (!progress) return '';
        const downloaded = formatBytes(progress.downloadedBytes);
        const total = progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : '';
        return `${Math.round(progress.percent)}% (${downloaded}${total})`;
    }, [progress]);

    const buttonLabel = phase === 'checking'
        ? 'Checking…'
        : metadata
            ? `Update ${metadata.version}`
            : 'Check for updates';

    return (
        <div className="update-center no-drag">
            <button
                type="button"
                className="update-center-trigger"
                disabled={phase === 'checking' || phase === 'installing'}
                aria-expanded={expanded}
                aria-controls="update-center-panel"
                onClick={() => metadata || message ? setExpanded((value) => !value) : void check()}
            >
                {buttonLabel}
            </button>
            {expanded && (
                <section id="update-center-panel" className="update-center-panel" aria-label="Application update">
                    <div className="update-center-heading">
                        <strong>{metadata ? `XEXAMAI ${metadata.version}` : 'Application update'}</strong>
                        <button type="button" aria-label="Close update panel" onClick={() => setExpanded(false)}>×</button>
                    </div>
                    {metadata && (
                        <>
                            <div className="update-center-version">
                                Installed {metadata.currentVersion}{metadata.date ? ` · ${new Date(metadata.date).toLocaleDateString()}` : ''}
                            </div>
                            {metadata.notes && <div className="update-center-notes">{metadata.notes}</div>}
                        </>
                    )}
                    <div className="update-center-status" role="status" aria-live="polite">
                        {phase === 'checking' && 'Checking for a signed update…'}
                        {phase === 'available' && 'Ready to download. Installation starts only when you choose it.'}
                        {phase === 'downloading' && `Downloading ${progressText}`}
                        {phase === 'downloaded' && (busyReason || 'Download verified. Install now or keep working and install later.')}
                        {phase === 'installing' && (message || 'Starting the installer…')}
                        {phase === 'error' && `Update failed: ${message}`}
                        {phase === 'idle' && message}
                    </div>
                    {phase === 'downloading' && (
                        <progress max={100} value={progress?.percent ?? 0} aria-label="Update download progress"/>
                    )}
                    <div className="update-center-actions">
                        {(phase === 'idle' || phase === 'error') && (
                            <button type="button" onClick={() => void check()}>Check again</button>
                        )}
                        {phase === 'available' && (
                            <button type="button" onClick={() => void download()}>Download</button>
                        )}
                        {phase === 'downloaded' && (
                            <>
                                <button type="button" disabled={!!busyReason} title={busyReason || undefined} onClick={() => void install()}>Install update</button>
                                <button type="button" onClick={() => setExpanded(false)}>Later</button>
                                <button type="button" onClick={() => void discard()}>Remove download</button>
                            </>
                        )}
                    </div>
                </section>
            )}
        </div>
    );
}
