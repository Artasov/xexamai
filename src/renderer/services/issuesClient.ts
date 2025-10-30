import axios from 'axios';
import {resolveAuthApiBaseUrl} from '../../shared/appUrls';
import {authClient} from './authClient';

export type IssueReportPayload = {
    subject: string;
    message: string;
    telegram?: string;
    files: File[];
};

function buildMessage(payload: IssueReportPayload): string {
    const base = payload.message.trim();
    if (!payload.telegram) {
        return base;
    }
    const contact = payload.telegram.trim();
    if (!contact.length) {
        return base;
    }
    return `${base}\n\nTelegram: ${contact}`;
}

export async function submitIssueReport(payload: IssueReportPayload): Promise<void> {
    const baseUrl = resolveAuthApiBaseUrl();
    const formData = new FormData();
    formData.append('subject', payload.subject.trim());
    formData.append('message', buildMessage(payload));
    payload.files.forEach((file) => {
        formData.append('files', file);
    });

    const tokens = authClient.getTokens();
    const headers: Record<string, string> = {
        Accept: 'application/json',
    };

    if (tokens?.access) {
        headers.Authorization = `Bearer ${tokens.access}`;
    }

    try {
        await axios.post(`${baseUrl}/issues/`, formData, {
            headers: {
                ...headers,
                'Content-Type': 'multipart/form-data',
            },
        });
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const message =
                (typeof error.response?.data === 'string' && error.response.data) ||
                error.response?.statusText ||
                error.message ||
                'Failed to submit the report.';
            throw new Error(status ? `${message} (status ${status})` : message);
        }
        throw error instanceof Error ? error : new Error('Failed to submit the report.');
    }
}
