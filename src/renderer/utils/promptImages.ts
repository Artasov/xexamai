import type {PromptImageAttachment} from '@shared/ipc';

export const MAX_PROMPT_IMAGES = 4;
export const MAX_PROMPT_IMAGE_BASE64_CHARS = 11 * 1024 * 1024;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1920;

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error('Unable to read image'));
        reader.onload = () => {
            const value = typeof reader.result === 'string' ? reader.result : '';
            resolve(value.slice(value.indexOf(',') + 1));
        };
        reader.readAsDataURL(blob);
    });
}

export async function imageFileToPromptAttachment(file: File): Promise<PromptImageAttachment> {
    if (!file.type.startsWith('image/')) throw new Error('Clipboard item is not an image.');
    if (file.size > MAX_SOURCE_BYTES) throw new Error('The pasted image is larger than 12 MB.');

    const bitmap = await createImageBitmap(file);
    try {
        const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Unable to prepare the pasted image.');
        context.drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
                (value) => value ? resolve(value) : reject(new Error('Unable to encode the pasted image.')),
                'image/jpeg',
                0.88,
            );
        });
        return {
            id: crypto.randomUUID(),
            mime: 'image/jpeg',
            base64: await blobToBase64(blob),
            name: file.name || 'Pasted image',
            width,
            height,
        };
    } finally {
        bitmap.close();
    }
}

export function imagePreviewUrl(image: PromptImageAttachment): string {
    return `data:${image.mime};base64,${image.base64}`;
}
