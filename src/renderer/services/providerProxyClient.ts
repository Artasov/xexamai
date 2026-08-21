import {Channel} from '@tauri-apps/api/core';
import {invokeNative as invoke} from '../bridge/nativeInvoke';
import type {ProviderStreamEvent} from '@shared/generated/NativeBindings';

export async function providerProxyFetch(
    provider: 'openai' | 'google',
    operation:
        | 'chatCompletions'
        | 'generateContent'
        | 'streamGenerateContent'
        | 'screenChatCompletions'
        | 'screenGenerateContent',
    body: Record<string, unknown>,
    options: {model?: string; stream?: boolean; signal?: AbortSignal; timeoutMs?: number} = {},
): Promise<Response> {
    const requestId = crypto.randomUUID();
    const request = {
        requestId,
        provider,
        operation,
        model: options.model,
        body,
        timeoutMs: options.timeoutMs,
    };
    if (!options.stream) {
        if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        const cancel = () => {
            void invoke('provider_proxy_cancel', {requestId});
        };
        options.signal?.addEventListener('abort', cancel, {once: true});
        try {
            const result = await invoke('provider_proxy_request', {request});
            if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
            return new Response(result.body, {
                status: result.status,
                headers: result.contentType ? {'Content-Type': result.contentType} : undefined,
            });
        } finally {
            options.signal?.removeEventListener('abort', cancel);
        }
    }

    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settledHeaders = false;
    let closed = false;
    let resolveHeaders!: (value: {status: number; contentType?: string | null}) => void;
    let rejectHeaders!: (reason: unknown) => void;
    const headers = new Promise<{status: number; contentType?: string | null}>((resolve, reject) => {
        resolveHeaders = resolve;
        rejectHeaders = reject;
    });
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;
        },
        cancel() {
            closed = true;
            void invoke('provider_proxy_cancel', {requestId});
        },
    });
    const fail = (error: unknown) => {
        if (closed) return;
        closed = true;
        if (!settledHeaders) rejectHeaders(error);
        else streamController?.error(error);
    };
    const onAbort = () => {
        void invoke('provider_proxy_cancel', {requestId});
        fail(new DOMException('Request aborted', 'AbortError'));
    };
    options.signal?.addEventListener('abort', onAbort, {once: true});
    if (options.signal?.aborted) onAbort();

    const channel = new Channel<ProviderStreamEvent>();
    channel.onmessage = (event) => {
        if (closed) return;
        if (event.kind === 'headers') {
            settledHeaders = true;
            resolveHeaders({status: event.status, contentType: event.contentType});
        } else if (event.kind === 'chunk') {
            streamController?.enqueue(event.data instanceof Uint8Array ? event.data : Uint8Array.from(event.data));
        } else if (event.kind === 'error') {
            fail(new Error(event.message));
        } else {
            closed = true;
            streamController?.close();
        }
    };
    void invoke('provider_proxy_stream', {request, onEvent: channel})
        .catch(fail)
        .finally(() => options.signal?.removeEventListener('abort', onAbort));
    const responseHeaders = await headers;
    return new Response(stream, {
        status: responseHeaders.status,
        headers: responseHeaders.contentType ? {'Content-Type': responseHeaders.contentType} : undefined,
    });
}
