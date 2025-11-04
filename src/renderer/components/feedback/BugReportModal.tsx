import {ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState} from 'react';
import {
    Alert,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    List,
    ListItem,
    ListItemText,
    Stack,
    TextField,
    Typography,
} from '@mui/material';
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

export function BugReportModal({open, onClose, onSubmit, onAfterSuccess}: BugReportModalProps) {
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
        if (!subject.trim() || !message.trim()) return true;
        return submitting;
    }, [subject, message, submitting]);

    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const nextFiles = Array.from(event.target.files ?? []).slice(0, 5);
        setFiles(nextFiles);
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (success) {
            onClose();
            return;
        }

        if (!onSubmit) {
            setSuccess(true);
            onAfterSuccess?.();
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

    const handleClose = () => {
        if (submitting) return;
        onClose();
    };

    return (
        <Dialog open={open} onClose={handleClose} keepMounted>
            <DialogTitle>
                <Box display="flex" alignItems="center" justifyContent="space-between" gap={2}>
                    <Typography variant="h6" component="h3">
                        Report a bug
                    </Typography>
                    <IconButton aria-label="Close bug report modal" onClick={handleClose} disabled={submitting}>
                        <CloseIcon fontSize="small"/>
                    </IconButton>
                </Box>
            </DialogTitle>

            <form onSubmit={handleSubmit}>
                <DialogContent
                    sx={{
                        pt: 1,
                        maxHeight: '60vh',
                        overflow: 'auto',
                    }}
                    dividers
                    className="custom-dropdown-scrollbar"
                >
                    {!success ? (
                        <Typography variant="body2" color="text.secondary" mt={1}>
                            Xexamai is currently in beta — unexpected behaviour is possible. Please share anything that
                            feels off so we can fix it quickly.
                        </Typography>
                    ) : null}
                    {!success ? (
                        <Typography variant="body2" color="text.secondary" mt={1} mb={3}>
                            Tell us what happened. Include steps to reproduce if possible.
                        </Typography>
                    ) : null}
                    <Stack spacing={2}>
                        {success ? (
                            <Stack spacing={1.5} alignItems="flex-start">
                                <Typography variant="body1" color="text.primary">
                                    Your report has been registered successfully.
                                </Typography>
                                <Typography variant="body2" color="text.secondary">
                                    I will get back to you as soon as I can. Thank you for helping us improve the beta!
                                </Typography>
                            </Stack>
                        ) : (
                            <Stack spacing={1.5}>
                                <TextField
                                    required
                                    id="bug-report-subject"
                                    label="Subject"
                                    value={subject}
                                    onChange={(event) => setSubject(event.target.value)}
                                    autoFocus
                                />

                                <TextField
                                    required
                                    id="bug-report-message"
                                    label="Details"
                                    value={message}
                                    onChange={(event) => setMessage(event.target.value)}
                                    multiline
                                    minRows={5}
                                />

                                <TextField
                                    id="bug-report-telegram"
                                    label="Telegram (optional)"
                                    value={telegram}
                                    onChange={(event) => setTelegram(event.target.value)}
                                    placeholder="@nickname if you prefer a reply in Telegram"
                                />

                                <Stack spacing={1}>
                                    <Button
                                        variant="outlined"
                                        className={'w-fit'}
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={submitting}
                                    >
                                        Attach screenshots
                                    </Button>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/*"
                                        multiple
                                        hidden
                                        onChange={handleFileChange}
                                    />
                                    <Typography variant="caption" color="text.secondary">
                                        Attach up to 5 screenshots (images only).
                                    </Typography>
                                    {files.length > 0 ? (
                                        <List dense disablePadding>
                                            {files.map((file) => (
                                                <ListItem
                                                    key={`${file.name}-${file.lastModified}`}
                                                    disableGutters
                                                    sx={{py: 0.25}}
                                                >
                                                    <ListItemText
                                                        primary={file.name}
                                                        secondary={`${Math.round(file.size / 1024)} KB`}
                                                        primaryTypographyProps={{variant: 'body2'}}
                                                        secondaryTypographyProps={{variant: 'caption'}}
                                                    />
                                                </ListItem>
                                            ))}
                                        </List>
                                    ) : null}
                                </Stack>
                            </Stack>
                        )}

                        {error ? <Alert severity="error">{error}</Alert> : null}
                    </Stack>
                </DialogContent>

                <DialogActions>
                    <Button onClick={handleClose} disabled={submitting}>
                        {success ? 'Close' : 'Cancel'}
                    </Button>
                    {!success ? (
                        <Button type="submit" variant="contained" disabled={isSubmitDisabled}>
                            {submitting ? 'Sending…' : 'Send'}
                        </Button>
                    ) : null}
                </DialogActions>
            </form>
        </Dialog>
    );
}
