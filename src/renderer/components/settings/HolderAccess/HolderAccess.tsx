import { useEffect, useMemo, useState } from 'react';
import {TextField} from '@mui/material';
import type { HolderChallengeInfo, HolderStatus } from '../../../types';
import { fetchHolderStatus, requestHolderChallenge, verifyHolderSignature, resetHolderState } from '../../../services/holderClient';
import { subscribeHolderState, setHolderLoading, setHolderStatus, getHolderState } from '../../../state/holderState';
import { logger } from '../../../utils/logger';
import './HolderAccess.scss';

type FeedbackTone = 'success' | 'error';
type Feedback = { text: string; tone: FeedbackTone } | null;

function describeStatus(status: HolderStatus | null): string {
    if (!status) return 'Unknown';
    if (status.error) return `Error: ${status.error}`;
    if (status.needsSignature) return 'Signature required';
    if (status.isAuthorized) return status.hasToken ? 'Verified holder' : 'Authorized';
    if (status.hasToken) return 'Token detected';
    return 'Not verified';
}

export const HolderAccess = () => {
    const [{ status, loading }, setSnapshot] = useState(getHolderState());
    const [signature, setSignature] = useState('');
    const [feedback, setFeedback] = useState<Feedback>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        const unsubscribe = subscribeHolderState(setSnapshot);
        void refreshStatus();
        return unsubscribe;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const header = document.querySelector('header h1');
        const crownId = 'holder-crown-indicator';
        let crown = document.getElementById(crownId) as HTMLImageElement | null;

        if (status?.isAuthorized || status?.hasToken) {
            if (!crown && header?.parentElement) {
                crown = document.createElement('img');
                crown.id = crownId;
                crown.src = 'img/icons/crown.png';
                crown.alt = 'Holder crown';
                crown.title = 'Holder access active';
                crown.style.width = '18px';
                crown.style.height = '18px';
                crown.style.marginLeft = '6px';
                crown.style.pointerEvents = 'none';
                header.insertAdjacentElement('afterend', crown);
            }
            if (crown) crown.style.display = 'inline';
        } else if (crown) {
            crown.style.display = 'none';
        }

        return () => {
            // keep crown for future sessions
        };
    }, [status?.isAuthorized, status?.hasToken]);

    const challenge = status?.challenge ?? null;
    const statusDescription = useMemo(() => describeStatus(status), [status]);

    const showFeedback = (text: string, tone: FeedbackTone = 'success') => {
        setFeedback({ text, tone });
        setTimeout(() => {
            setFeedback((prev) => (prev?.text === text ? null : prev));
        }, 2800);
    };

    async function refreshStatus(force = false) {
        try {
            setHolderLoading(true);
            const snapshot = await fetchHolderStatus(force);
            setHolderStatus(snapshot);
        } catch (error) {
            logger.error('holder', 'Failed to fetch status', { error });
            showFeedback('Failed to fetch holder status', 'error');
        } finally {
            setHolderLoading(false);
        }
    }

    async function createChallenge(openModalAfter = false) {
        try {
            setHolderLoading(true);
            const result = await requestHolderChallenge();
            setHolderStatus(result);
            if (openModalAfter) {
                setModalOpen(true);
            }
            showFeedback('Challenge created. Sign the link to continue.');
        } catch (error) {
            logger.error('holder', 'Failed to create challenge', { error });
            showFeedback('Failed to create challenge', 'error');
        } finally {
            setHolderLoading(false);
        }
    }

    async function verifySignatureValue() {
        const trimmed = signature.trim();
        if (!trimmed) {
            showFeedback('Signature cannot be empty', 'error');
            return;
        }
        setSubmitting(true);
        try {
            const result = await verifyHolderSignature(trimmed);
            if (result.ok) {
                await refreshStatus(true);
                setSignature('');
                showFeedback('Holder access verified');
                setModalOpen(false);
            } else {
                showFeedback(result.error || result.message || 'Verification failed', 'error');
            }
        } catch (error) {
            logger.error('holder', 'Failed to verify signature', { error });
            showFeedback('Failed to verify signature', 'error');
        } finally {
            setSubmitting(false);
        }
    }

    const openModal = async () => {
        if (!status?.challenge) {
            await createChallenge(true);
        } else {
            setModalOpen(true);
        }
    };

    const closeModal = () => {
        setModalOpen(false);
    };

    const resetAccess = async () => {
        try {
            await resetHolderState();
            await refreshStatus(true);
            setSignature('');
            showFeedback('Holder state reset');
        } catch (error) {
            logger.error('holder', 'Failed to reset holder state', { error });
            showFeedback('Failed to reset holder state', 'error');
        }
    };

    const copyDeeplink = async (challengeInfo: HolderChallengeInfo) => {
        try {
            await navigator.clipboard.writeText(challengeInfo.deeplink);
            showFeedback('Deep link copied to clipboard');
        } catch (error) {
            logger.error('holder', 'Failed to copy deeplink', { error });
            showFeedback('Failed to copy deep link', 'error');
        }
    };

    const statusDetails = useMemo(() => {
        if (!status) return null;
        return [
            status.wallet ? `Wallet: ${status.wallet}` : null,
            status.tokenBalance ? `Token balance: ${status.tokenBalance}` : null,
            status.lastVerified ? `Last verified: ${new Date(status.lastVerified).toLocaleString()}` : null,
            status.error ? `Error: ${status.error}` : null,
        ].filter(Boolean);
    }, [status]);

    return (
        <section className="card holder-card">
            <div className="holder-card__header">
                <h3 className="settings-card__title">Holder access</h3>
                <div className={`holder-status holder-status--${status?.isAuthorized ? 'success' : 'neutral'}`}>
                    {statusDescription}
                </div>
            </div>

            {feedback ? (
                <div className={`holder-feedback holder-feedback--${feedback.tone}`}>{feedback.text}</div>
            ) : null}

            <div className="holder-card__body">
                <div className="holder-card__actions">
                    <button type="button" className="btn btn-sm" onClick={() => refreshStatus(true)} disabled={loading}>
                        Refresh status
                    </button>
                    <button type="button" className="btn btn-sm" onClick={openModal} disabled={loading}>
                        Verify access
                    </button>
                    <button type="button" className="btn btn-sm" onClick={resetAccess} disabled={loading}>
                        Reset
                    </button>
                </div>

                {statusDetails && statusDetails.length ? (
                    <ul className="holder-details">
                        {statusDetails.map((line, index) => (
                            <li key={index}>{line}</li>
                        ))}
                    </ul>
                ) : (
                    <p className="holder-helper">Generate a challenge and sign it to unlock holder-only features.</p>
                )}
            </div>

            {modalOpen ? (
                <div className="holder-modal-overlay" role="dialog" aria-modal="true">
                    <div className="holder-modal">
                        <div className="holder-modal__header">
                            <h2>Verify holder access</h2>
                            <button type="button" className="btn btn-sm" onClick={closeModal}>
                                ✕
                            </button>
                        </div>

                        <div className="holder-modal__content">
                            {challenge ? (
                                <>
                                    <div className="holder-challenge">
                                        <div className="holder-challenge__info">
                                            <p><strong>Reference:</strong> {challenge.reference}</p>
                                            <p><strong>Created:</strong> {new Date(challenge.createdAt).toLocaleString()}</p>
                                            <p><strong>Expires:</strong> {new Date(challenge.expiresAt).toLocaleString()}</p>
                                            <div className="holder-challenge__link">
                                                <span>{challenge.deeplink}</span>
                                                <button type="button" className="btn btn-sm" onClick={() => copyDeeplink(challenge)}>
                                                    Copy
                                                </button>
                                            </div>
                                            <button type="button" className="btn btn-sm" onClick={() => window.open(challenge.deeplink, '_blank')}>
                                                Open link
                                            </button>
                                        </div>
                                        {challenge.qrSvg ? (
                                            <div
                                                className="holder-challenge__qr"
                                                dangerouslySetInnerHTML={{ __html: challenge.qrSvg }}
                                            />
                                        ) : null}
                                    </div>
                                </>
                            ) : (
                                <div className="holder-helper">Generate a challenge to obtain the verification link.</div>
                            )}

                            <div className="holder-verification">
                                <label className="settings-field__label">Transaction signature</label>
                                <TextField
                                    id="holder-signature"
                                    placeholder="Paste signed transaction signature"
                                    value={signature}
                                    onChange={(event) => setSignature(event.target.value)}
                                />
                                <button type="button" className="btn btn-sm" onClick={verifySignatureValue} disabled={submitting}>
                                    Verify signature
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
        </section>
    );
};
