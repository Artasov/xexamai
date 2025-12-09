import {ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState} from 'react';

export type BugReportFormPayload = {
    subject: string;
    message: string;
    telegram: string;
    files: File[];
};

export function useBugReportState(open: boolean, onSubmit?: (payload: BugReportFormPayload) => Promise<void>, onAfterSuccess?: () => void) {
    const [subject, setSubject] = useState('');
    const [message, setMessage] = useState('');
    const [telegram, setTelegram] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

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
        if (!subject.trim() || !message.trim() || !telegram.trim()) return true;
        return submitting;
    }, [subject, message, telegram, submitting]);

    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const nextFiles = Array.from(event.target.files ?? []).slice(0, 5);
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

        const payload: BugReportFormPayload = {
            subject: subject.trim(),
            message: message.trim(),
            telegram: telegram.trim(),
            files,
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
            setSubmitting(false);
        }
    };

    const resetAfterClose = () => {
        setSuccess(false);
        setError(null);
    };

    return {
        fields: {subject, message, telegram, files},
        flags: {submitting, success, error, isSubmitDisabled},
        actions: {
            setSubject,
            setMessage,
            setTelegram,
            setFiles,
            handleFileChange,
            handleSubmit,
            resetAfterClose,
        },
        refs: {
            fileInputRef,
        },
    };
}
