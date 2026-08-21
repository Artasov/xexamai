import {sha256 as createSha256} from '@noble/hashes/sha2.js';
import {authClient} from './authClient';
import {beginNativeRendererActivity} from '../state/rendererActivity';

export type MediaVisibility = 'private' | 'public';

export type MediaFile = {
    id: number;
    url?: string | null;
    original_name: string;
    content_type: string;
    size: number;
    sha256: string;
    visibility: MediaVisibility | string;
    status: string;
    /** True only when this attempt created a record that may be cleaned up. */
    cleanupEligible?: boolean;
};

type DirectUploadResponse = {
    media_file: MediaFile;
    upload_url?: string | null;
    upload_method?: string;
    upload_headers?: Record<string, string>;
    already_uploaded?: boolean;
    expires_in?: number;
};

export type UploadMediaFileOptions = {
    namespace: string;
    visibility?: MediaVisibility;
    fileName?: string;
    contentType?: string;
    signal?: AbortSignal;
};

function digestToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

async function sha256(blob: Blob, signal?: AbortSignal): Promise<string> {
    const hasher = createSha256.create();
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
        if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
        const chunk = await blob.slice(offset, Math.min(blob.size, offset + chunkSize)).arrayBuffer();
        hasher.update(new Uint8Array(chunk));
    }
    return digestToHex(hasher.digest());
}

function fileNameFor(blob: Blob, options: UploadMediaFileOptions): string {
    const named = blob as Blob & {name?: string};
    return (options.fileName || named.name || 'file').trim() || 'file';
}

function contentTypeFor(blob: Blob, options: UploadMediaFileOptions): string {
    return (options.contentType || blob.type || 'application/octet-stream').trim() || 'application/octet-stream';
}

export async function uploadMediaFile(blob: Blob, options: UploadMediaFileOptions): Promise<MediaFile> {
    const releaseActivity = await beginNativeRendererActivity('Uploading media');
    try {
        if (options.signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    const originalName = fileNameFor(blob, options);
    const contentType = contentTypeFor(blob, options);
    const hash = await sha256(blob, options.signal);
    if (options.signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    const upload = await authClient.request<DirectUploadResponse>({
        url: '/media/uploads/',
        method: 'POST',
        data: {
            namespace: options.namespace,
            original_name: originalName,
            content_type: contentType,
            size: blob.size,
            sha256: hash,
            visibility: options.visibility ?? 'private',
        },
        signal: options.signal,
    });

    try {
        if (!upload.already_uploaded) {
            // Keep uploads on the authenticated backend origin. A dynamic S3
            // presigned origin cannot be represented by a strict desktop CSP,
            // and allowing it in renderer networking would re-introduce SSRF.
            await authClient.request<void>({
                url: `/media/uploads/${upload.media_file.id}/content/`,
                method: 'PUT',
                data: blob,
                headers: {
                    'Content-Type': upload.upload_headers?.['Content-Type'] ?? contentType,
                },
                timeout: 150_000,
                signal: options.signal,
            });
        }
        const completed = await authClient.request<MediaFile>({
            url: `/media/uploads/${upload.media_file.id}/complete/`,
            method: 'POST',
            signal: options.signal,
        });
        return {
            ...completed,
            cleanupEligible:
                !upload.already_uploaded && completed.id === upload.media_file.id,
        };
    } catch (error) {
        if (!upload.already_uploaded) {
            void authClient.request({
                url: `/media/uploads/${upload.media_file.id}/`,
                method: 'DELETE',
            }).catch(() => undefined);
        }
        throw error;
    }
    } finally {
        await releaseActivity();
    }
}
