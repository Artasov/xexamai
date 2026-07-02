import {AuthError, authClient} from './authClient';
import {uploadMediaFile} from './mediaClient';

export type IssueReportPayload = {
    subject: string;
    message: string;
    telegram: string;
    files: File[];
};

function buildMessage(payload: IssueReportPayload): string {
    const base = payload.message.trim();
    const contact = payload.telegram.trim();
    if (!contact.length) {
        return base;
    }
    const contactLabel = contact.startsWith('@') ? 'Telegram' : contact.includes('@') ? 'Email' : 'Contact';
    return `${base}\n\n${contactLabel}: ${contact}`;
}

export async function submitIssueReport(payload: IssueReportPayload): Promise<void> {
    try {
        const mediaFiles = await Promise.all(payload.files.map((file) => {
            return uploadMediaFile(file, {
                namespace: 'issues',
                visibility: 'private',
                fileName: file.name,
                contentType: file.type,
            });
        }));
        await authClient.request({
            url: '/issues/create/media/',
            method: 'POST',
            data: {
                subject: payload.subject.trim(),
                message: buildMessage(payload),
                media_file_ids: mediaFiles.map((file) => file.id),
            },
        });
    } catch (error) {
        if (error instanceof AuthError) {
            const retryAfter = error.headers?.['retry-after'];
            const retryText = retryAfter ? ` Retry after ${retryAfter} second(s).` : '';
            throw new Error(
                error.status
                    ? `${error.message} (status ${error.status}).${retryText}`
                    : error.message,
            );
        }
        throw error instanceof Error ? error : new Error('Failed to submit the report.');
    }
}
