import {AuthError, authClient} from './authClient';
import {uploadMediaFile} from './mediaClient';
import type {DiagnosticsSnapshot} from '@shared/ipc';
import {beginNativeRendererActivity} from '../state/rendererActivity';

export type IssueReportPayload = {
    subject: string;
    message: string;
    telegram: string;
    files: File[];
    includeDiagnostics: boolean;
    diagnostics?: DiagnosticsSnapshot;
    signal?: AbortSignal;
};

function buildMessage(payload: IssueReportPayload, diagnostics?: DiagnosticsSnapshot): string {
    const base = payload.message.trim();
    const contact = payload.telegram.trim();
    const sections = [base];
    if (contact.length) {
        const contactLabel = contact.startsWith('@') ? 'Telegram' : contact.includes('@') ? 'Email' : 'Contact';
        sections.push(`${contactLabel}: ${contact}`);
    }
    if (diagnostics) {
        sections.push([
            '--- Cleaned diagnostic snapshot (user opted in) ---',
            `Trace: ${diagnostics.traceId}`,
            `App: ${diagnostics.appVersion}; OS: ${diagnostics.os}/${diagnostics.architecture}`,
            `Backend: ${diagnostics.backendDomain}`,
            `LLM: ${diagnostics.provider}/${diagnostics.model}`,
            `Transcription: ${diagnostics.transcriptionMode}/${diagnostics.transcriptionModel}`,
            `Audio: ${diagnostics.audioMode}`,
            'Recent redacted log preview:',
            diagnostics.logPreview,
        ].join('\n'));
    }
    return sections.join('\n\n');
}

export async function submitIssueReport(payload: IssueReportPayload): Promise<void> {
    if (payload.includeDiagnostics && !payload.diagnostics) {
        throw new Error('Diagnostic snapshot is not ready. Review it or turn diagnostics off.');
    }
    const releaseActivity = await beginNativeRendererActivity('Sending feedback');
    const uploadedIds: number[] = [];
    try {
        const mediaFiles: Awaited<ReturnType<typeof uploadMediaFile>>[] = [];
        for (const file of payload.files) {
            const uploaded = await uploadMediaFile(file, {
                namespace: 'issues',
                visibility: 'private',
                fileName: file.name,
                contentType: file.type,
                signal: payload.signal,
            });
            mediaFiles.push(uploaded);
            if (uploaded.cleanupEligible) uploadedIds.push(uploaded.id);
        }
        const diagnostics = payload.includeDiagnostics ? payload.diagnostics : undefined;
        await authClient.request({
            url: '/issues/create/media/',
            method: 'POST',
            data: {
                subject: payload.subject.trim(),
                message: buildMessage(payload, diagnostics),
                media_file_ids: mediaFiles.map((file) => file.id),
            },
            signal: payload.signal,
        });
    } catch (error) {
        // Completed uploads are otherwise orphaned when another attachment or
        // the final issue creation fails. Cleanup is best-effort and must not
        // mask the original failure/cancellation.
        await Promise.allSettled(uploadedIds.map((id) => authClient.request({
            url: `/media/uploads/${id}/`,
            method: 'DELETE',
        })));
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
    } finally {
        await releaseActivity();
    }
}
