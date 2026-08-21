import {ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState} from 'react';
import {settingsStore} from '../../state/settingsStore';
import type {DiagnosticsSnapshot} from '@shared/ipc';

export type BugReportFormPayload = {
    subject: string;
    message: string;
    telegram: string;
    files: File[];
    includeDiagnostics: boolean;
    diagnostics?: DiagnosticsSnapshot;
    signal?: AbortSignal;
};

const MAX_FILES = 5;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_BUG_SUBJECT_CHARS = 255;
export const MAX_BUG_MESSAGE_CHARS = 12_000;
export const MAX_BUG_CONTACT_CHARS = 320;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export async function validateImageMagic(file: Blob): Promise<boolean> {
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const type = file.type.toLowerCase();
    if (type === 'image/png') {
        return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
            .every((value, index) => bytes[index] === value);
    }
    if (type === 'image/jpeg') {
        return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (type === 'image/webp') {
        const decoder = new TextDecoder();
        return bytes.length >= 12
            && decoder.decode(bytes.slice(0, 4)) === 'RIFF'
            && decoder.decode(bytes.slice(8, 12)) === 'WEBP';
    }
    if (type === 'image/gif') {
        const signature = new TextDecoder().decode(bytes.slice(0, 6));
        return signature === 'GIF87a' || signature === 'GIF89a';
    }
    return false;
}

export function useBugReportState(open: boolean, onSubmit?: (payload: BugReportFormPayload) => Promise<void>, onAfterSuccess?: () => void) {
    const [subject, setSubject] = useState('');
    const [message, setMessage] = useState('');
    const [telegram, setTelegram] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
    const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
    const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
    const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const submitControllerRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!open) {
            submitControllerRef.current?.abort('dialog-closed');
            submitControllerRef.current = null;
            setSubject('');
            setMessage('');
            setTelegram('');
            setFiles([]);
            setIncludeDiagnostics(false);
            setDiagnostics(null);
            setDiagnosticsLoading(false);
            setDiagnosticsError(null);
            setSubmitting(false);
            setError(null);
            setSuccess(false);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        } else {
            setSubmitting(false);
            setError(null);
            try {
                setIncludeDiagnostics(settingsStore.get().diagnosticsEnabled === true);
            } catch {
                setIncludeDiagnostics(false);
            }
        }
    }, [open]);

    useEffect(() => {
        let active = true;
        if (!open || !includeDiagnostics) {
            setDiagnostics(null);
            setDiagnosticsLoading(false);
            setDiagnosticsError(null);
            return () => {
                active = false;
            };
        }

        setDiagnostics(null);
        setDiagnosticsLoading(true);
        setDiagnosticsError(null);
        void window.api.diagnostics.snapshot()
            .then((snapshot) => {
                if (active) setDiagnostics(snapshot);
            })
            .catch(() => {
                if (active) {
                    setDiagnosticsError('Could not prepare the diagnostic excerpt. Retry or turn diagnostics off.');
                }
            })
            .finally(() => {
                if (active) setDiagnosticsLoading(false);
            });

        return () => {
            active = false;
        };
    }, [includeDiagnostics, open]);

    const isSubmitDisabled = useMemo(() => {
        if (!subject.trim() || !message.trim() || !telegram.trim()) return true;
        if (
            subject.length > MAX_BUG_SUBJECT_CHARS
            || message.length > MAX_BUG_MESSAGE_CHARS
            || telegram.length > MAX_BUG_CONTACT_CHARS
        ) return true;
        if (includeDiagnostics && (diagnosticsLoading || diagnosticsError !== null || diagnostics === null)) {
            return true;
        }
        return submitting;
    }, [subject, message, telegram, includeDiagnostics, diagnostics, diagnosticsError, diagnosticsLoading, submitting]);

    const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
        const selected = Array.from(event.target.files ?? []);
        const invalidType = selected.find((file) => !ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase()));
        const tooLarge = selected.find((file) => file.size > MAX_FILE_BYTES);
        const totalBytes = selected.reduce((sum, file) => sum + file.size, 0);
        if (selected.length > MAX_FILES) {
            setError(`Attach no more than ${MAX_FILES} images.`);
            return;
        }
        if (invalidType) {
            setError(`${invalidType.name} is not a supported image type.`);
            return;
        }
        if (tooLarge) {
            setError(`${tooLarge.name} exceeds the 15 MB per-file limit.`);
            return;
        }
        if (totalBytes > MAX_TOTAL_BYTES) {
            setError('Attachments exceed the 40 MB total limit.');
            return;
        }
        const invalidMagic = (await Promise.all(selected.map(async (file) => ({
            file,
            valid: await validateImageMagic(file),
        })))).find((entry) => !entry.valid);
        if (invalidMagic) {
            setError(`${invalidMagic.file.name} content does not match its declared image type.`);
            return;
        }
        const nextFiles = selected.slice(0, MAX_FILES);
        setError(null);
        setFiles(nextFiles);
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<boolean> => {
        event.preventDefault();
        if (success) {
            return true;
        }

        if (!onSubmit) {
            setSuccess(true);
            onAfterSuccess?.();
            return true;
        }

        if (
            subject.length > MAX_BUG_SUBJECT_CHARS
            || message.length > MAX_BUG_MESSAGE_CHARS
            || telegram.length > MAX_BUG_CONTACT_CHARS
        ) {
            setError('The report text exceeds the allowed length.');
            return false;
        }

        submitControllerRef.current?.abort('superseded');
        const submitController = new AbortController();
        submitControllerRef.current = submitController;
        const payload: BugReportFormPayload = {
            subject: subject.trim(),
            message: message.trim(),
            telegram: telegram.trim(),
            files,
            includeDiagnostics,
            diagnostics: includeDiagnostics ? diagnostics ?? undefined : undefined,
            signal: submitController.signal,
        };

        setSubmitting(true);
        setError(null);
        try {
            await onSubmit(payload);
            setSuccess(true);
            onAfterSuccess?.();
            return true;
        } catch (err) {
            const messageText =
                err instanceof Error
                    ? err.message
                    : typeof err === 'string'
                        ? err
                        : 'Failed to send the report. Please try again.';
            setError(messageText);
            return false;
        } finally {
            if (submitControllerRef.current === submitController) submitControllerRef.current = null;
            setSubmitting(false);
        }
    };

    const resetAfterClose = () => {
        setSuccess(false);
        setError(null);
    };

    const cancelSubmit = () => {
        submitControllerRef.current?.abort('user-cancelled');
        submitControllerRef.current = null;
        setSubmitting(false);
    };

    return {
        fields: {subject, message, telegram, files, includeDiagnostics, diagnostics},
        flags: {submitting, success, error, diagnosticsLoading, diagnosticsError, isSubmitDisabled},
        actions: {
            setSubject,
            setMessage,
            setTelegram,
            setFiles,
            setIncludeDiagnostics,
            handleFileChange,
            handleSubmit,
            resetAfterClose,
            cancelSubmit,
        },
        refs: {
            fileInputRef,
        },
    };
}
