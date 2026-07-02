import axios from 'axios';
import {authClient} from './authClient';

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
};

function digestToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

async function sha256(blob: Blob): Promise<string> {
    if (!crypto?.subtle) {
        throw new Error('Secure hash API is unavailable.');
    }
    return digestToHex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
}

function fileNameFor(blob: Blob, options: UploadMediaFileOptions): string {
    const named = blob as Blob & {name?: string};
    return (options.fileName || named.name || 'file').trim() || 'file';
}

function contentTypeFor(blob: Blob, options: UploadMediaFileOptions): string {
    return (options.contentType || blob.type || 'application/octet-stream').trim() || 'application/octet-stream';
}

export async function uploadMediaFile(blob: Blob, options: UploadMediaFileOptions): Promise<MediaFile> {
    const originalName = fileNameFor(blob, options);
    const contentType = contentTypeFor(blob, options);
    const hash = await sha256(blob);
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
    });

    if (!upload.already_uploaded) {
        if (!upload.upload_url) {
            throw new Error('Media upload URL is missing.');
        }
        await axios.put(upload.upload_url, blob, {
            headers: upload.upload_headers ?? {},
            timeout: 150_000,
            withCredentials: false,
        });
    }

    return authClient.request<MediaFile>({
        url: `/media/uploads/${upload.media_file.id}/complete/`,
        method: 'POST',
    });
}
