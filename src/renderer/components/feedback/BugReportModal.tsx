import {ChangeEvent, FormEvent, MouseEvent, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import CloseIcon from '@mui/icons-material/Close';

export type BugReportFormPayload = {
    subject: string;
    message: string;
    telegram?: string;
    files: File[];
};

export type BugReportModalProps = {
    open: boolean;
    onClose: () => void;
    onSubmit?: (payload: BugReportFormPayload) => Promise<void>;
    onAfterSuccess?: () => void;
};

const TRANSITION_MS = 220;

export function BugReportModal({open, onClose, onSubmit, onAfterSuccess}: BugReportModalProps) {
    const [isMounted, setMounted] = useState(open);
    const [isVisible, setVisible] = useState(open);
    const [subject, setSubject] = useState('');
    const [message, setMessage] = useState('');
    const [telegram, setTelegram] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        let timeoutId: number | null = null;
        let rafId1: number | null = null;
        let rafId2: number | null = null;

        if (open) {
            setMounted(true);
            rafId1 = window.requestAnimationFrame(() => {
                rafId2 = window.requestAnimationFrame(() => {
                    setVisible(true);
                });
            });
        } else {
            setVisible(false);
            timeoutId = window.setTimeout(() => setMounted(false), TRANSITION_MS);
        }

        return () => {
            if (timeoutId) {
                window.clearTimeout(timeoutId);
            }
            if (rafId1) {
                window.cancelAnimationFrame(rafId1);
            }
            if (rafId2) {
                window.cancelAnimationFrame(rafId2);
            }
        };
    }, [open]);

    useEffect(() => {
        if (!open) {
            setSubject('');
            setMessage('');
            setTelegram('');
            setFiles([]);
            setSubmitting(false);
            setError(null);
            setSuccess(false);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        } else {
            setSubmitting(false);
            setError(null);
        }
    }, [open]);

    const isSubmitDisabled = useMemo(() => {
        if (!subject.trim() || !message.trim()) return true;
        return submitting;
    }, [subject, message, submitting]);

    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const nextFiles = Array.from(event.target.files ?? []).slice(0, 5);
        setFiles(nextFiles);
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!onSubmit) {
            setSuccess(true);
            return;
        }

        const payload: BugReportFormPayload = {
            subject: subject.trim(),
            message: message.trim(),
            telegram: telegram.trim() || undefined,
            files,
        };

        setSubmitting(true);
        setError(null);
        try {
            await onSubmit(payload);
            setSuccess(true);
            onAfterSuccess?.();
        } catch (err) {
            const messageText =
                err instanceof Error
                    ? err.message
                    : typeof err === 'string'
                        ? err
                        : 'Failed to send the report. Please try again.';
            setError(messageText);
        } finally {
            setSubmitting(false);
        }
    };

    const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) {
            onClose();
        }
    };

    if (!isMounted) {
        return null;
    }

    const overlayClassName = [
        'holder-overlay',
        'holder-modal-overlay',
        'bug-report-overlay',
        isVisible ? 'bug-report-overlay--visible' : '',
    ].join(' ');

    const modalClassName = [
        'holder-modal',
        'card',
        'bug-report-modal',
        'overflow-y-auto',
        isVisible ? 'bug-report-modal--visible' : '',
    ].join(' ');

    return createPortal(
        <div
            className={overlayClassName}
            role="dialog"
            aria-modal="true"
            aria-labelledby="bug-report-modal-title"
            onClick={handleOverlayClick}
        >
            <div className={modalClassName}>
                <div className="modal-header flex items-start justify-between gap-4">
                    <div className="space-y-2">
                        <h3 id="bug-report-modal-title" className="text-lg font-semibold text-gray-100">
                            Report a bug
                        </h3>
                        <p className="text-sm text-gray-300">
                            Xexamai is currently in beta — unexpected behaviour is possible. Please share anything that
                            feels off so we can fix it quickly.
                        </p>
                        {!success ? (
                            <p className="text-sm text-gray-400">
                                Tell us what happened. Include steps to reproduce if possible.
                            </p>
                        ) : null}
                    </div>
                    <button
                        type="button"
                        aria-label="Close bug report modal"
                        className="text-gray-400 transition hover:text-gray-100"
                        style={{ cursor: 'pointer' }}
                        onClick={onClose}
                    >
                        <CloseIcon fontSize="small" />
                    </button>
                </div>

                {success ? (
                    <div className="modal-content space-y-3 text-sm text-gray-200">
                        <p>Your report has been registered successfully.</p>
                        <p>I will get back to you as soon as I can. Thank you for helping us improve the beta!</p>
                        <button
                            type="button"
                            className="btn btn-primary text-sm"
                            style={{ cursor: 'pointer' }}
                            onClick={onClose}
                        >
                            Close
                        </button>
                    </div>
                ) : (
                    <form className="modal-content text-sm" onSubmit={handleSubmit}>
                        <label className="block">
                            <span className="mb-1 block text-xs uppercase tracking-wide text-gray-400">Subject</span>
                            <input
                                required
                                type="text"
                                value={subject}
                                onChange={(event) => setSubject(event.target.value)}
                                className="input-field w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-purple-400 focus:outline-none focus:ring-0"
                                placeholder="What is the issue about?"
                                style={{ cursor: 'text' }}
                            />
                        </label>

                        <label className="block">
                            <span className="mb-1 block text-xs uppercase tracking-wide text-gray-400">Details</span>
                            <textarea
                                required
                                value={message}
                                onChange={(event) => setMessage(event.target.value)}
                                className="input-field h-32 w-full resize-none rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-purple-400 focus:outline-none focus:ring-0"
                                placeholder="Describe what happened and how to reproduce it."
                                style={{ cursor: 'text' }}
                            />
                        </label>

                        <label className="block">
                            <span className="mb-1 block text-xs uppercase tracking-wide text-gray-400">
                                Telegram (optional)
                            </span>
                            <input
                                type="text"
                                value={telegram}
                                onChange={(event) => setTelegram(event.target.value)}
                                className="input-field w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-purple-400 focus:outline-none focus:ring-0"
                                placeholder="@nickname if you want to receive a reply via Telegram"
                                style={{ cursor: 'text' }}
                            />
                        </label>

                        <label className="block">
                            <span className="mb-1 block text-xs uppercase tracking-wide text-gray-400">
                                Screenshots (optional)
                            </span>
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                accept="image/*"
                                className="w-full text-xs text-gray-300 file:mr-3 file:rounded file:border-0 file:bg-purple-500/20 file:px-3 file:py-2 file:text-sm file:text-purple-200 hover:file:bg-purple-500/30"
                                onChange={handleFileChange}
                                style={{ cursor: 'pointer' }}
                            />
                            <p className="mt-1 text-xs text-gray-500">Attach up to 5 screenshots (images only).</p>
                        </label>

                        {files.length > 0 && (
                            <ul className="space-y-1 text-xs text-gray-400">
                                {files.map((file) => (
                                    <li key={`${file.name}-${file.lastModified}`}>
                                        {file.name} ({Math.round(file.size / 1024)} KB)
                                    </li>
                                ))}
                            </ul>
                        )}

                        {error ? (
                            <p className="text-xs text-red-400">{error}</p>
                        ) : null}

                        <div className="flex justify-end gap-2 pt-1">
                            <button
                                type="button"
                                className="btn btn-secondary text-sm"
                                style={{ cursor: 'pointer' }}
                                onClick={onClose}
                                disabled={submitting}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="btn btn-primary text-sm"
                                style={{ cursor: isSubmitDisabled ? 'not-allowed' : 'pointer' }}
                                disabled={isSubmitDisabled}
                            >
                                {submitting ? 'Sending…' : 'Send'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>,
        document.body,
    );
}
