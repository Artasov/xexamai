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
    const cancelNativeRequest = () => {
        void invoke('provider_proxy_cancel', {requestId}).catch(() => undefined);
    };
    if (!options.stream) {
        if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        const cancel = () => cancelNativeRequest();
        options.signal?.addEventListener('abort', cancel, {once: true});
        if (options.signal?.aborted) {
            // Abort may land between the initial check and listener
            // registration. Leave a native tombstone before returning so a
            // concurrently queued command cannot start afterward.
            cancel();
            options.signal.removeEventListener('abort', cancel);
            throw new DOMException('Request aborted', 'AbortError');
        }
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

    // Do not dispatch a native command after an auto-supersession has already
    // won the race. Native tombstones are a final safety net, not a reason to
    // enqueue work that can already be proven stale in the renderer.
    if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');

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
            cancelNativeRequest();
        },
    });
    const fail = (error: unknown) => {
        if (closed) return;
        closed = true;
        if (!settledHeaders) rejectHeaders(error);
        else streamController?.error(error);
    };
    const onAbort = () => {
        cancelNativeRequest();
        fail(new DOMException('Request aborted', 'AbortError'));
    };
    options.signal?.addEventListener('abort', onAbort, {once: true});
    if (options.signal?.aborted) {
        options.signal.removeEventListener('abort', onAbort);
        cancelNativeRequest();
        // A deliberately adversarial AbortSignal can fire the newly-added
        // listener synchronously. In that case `onAbort` has already rejected
        // this private promise; observe it before throwing to avoid an
        // unhandled-rejection leak.
        void headers.catch(() => undefined);
        throw new DOMException('Request aborted', 'AbortError');
    }

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
