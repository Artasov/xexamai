import axios from 'axios';
import axiosTauriApiAdapter from 'axios-tauri-api-adapter';

// Axios инстанс для Ollama запросов (обходит CORS)
const ollamaAxios = axios.create({
    adapter: axiosTauriApiAdapter,
    baseURL: 'http://localhost:11434',
    timeout: 600000,
});

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit, timeoutMs?: number) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    
    // Для запросов к localhost:11434
    if (url.includes('localhost:11434') || url.includes('127.0.0.1:11434')) {
        const body = init.body ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : undefined;
        const isStreaming = body?.includes('"stream":true');
        
        // Для streaming используем Tauri HTTP API напрямую (axios-tauri-api-adapter не поддерживает streaming)
        if (isStreaming) {
            return fetchWithTauriHttp(url, init, timeoutMs);
        } else {
            // Для обычных запросов используем axios
            return fetchWithAxiosTauri(url, init, timeoutMs);
        }
    }

    const hasTimeout = typeof timeoutMs === 'number' && timeoutMs > 0;

    const fetchOptions: RequestInit = {
        ...init,
    };

    if (!hasTimeout && !init.signal) {
        return fetch(input, fetchOptions);
    }

    const controller = new AbortController();
    const userSignal = init.signal;

    if (userSignal) {
        if (userSignal.aborted) {
            controller.abort((userSignal as any).reason);
        } else {
            const abortHandler = () => controller.abort((userSignal as any).reason);
            userSignal.addEventListener('abort', abortHandler, {once: true});
        }
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (hasTimeout) {
        timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
    }

    try {
        return await fetch(input, {...fetchOptions, signal: controller.signal});
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
};

// Fetch через axios с Tauri адаптером для обычных запросов (без streaming)
async function fetchWithAxiosTauri(
    url: string,
    init: RequestInit,
    timeoutMs?: number
): Promise<Response> {
    const hasTimeout = typeof timeoutMs === 'number' && timeoutMs > 0;
    const timeout = hasTimeout ? timeoutMs : 600000;

    const headers: Record<string, string> = {};
    if (init.headers) {
        if (init.headers instanceof Headers) {
            init.headers.forEach((value, key) => {
                headers[key] = value;
            });
        } else if (Array.isArray(init.headers)) {
            init.headers.forEach(([key, value]) => {
                headers[key] = value;
            });
        } else {
            Object.assign(headers, init.headers);
        }
    }

    const body = init.body ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : undefined;

    try {
        const axiosConfig: any = {
            method: (init.method as any) || 'GET',
            url,
            headers,
            timeout,
            responseType: 'text',
            signal: init.signal,
        };

        if (body) {
            axiosConfig.data = body;
        }

        const response = await ollamaAxios.request(axiosConfig);

        // Преобразуем axios Response в стандартный Response
        const status = response.status;
        const statusText = response.statusText || '';
        const responseHeaders = new Headers();
        
        if (response.headers) {
            Object.entries(response.headers).forEach(([key, value]) => {
                if (typeof value === 'string') {
                    responseHeaders.set(key, value);
                } else if (Array.isArray(value)) {
                    responseHeaders.set(key, value.join(', '));
                }
            });
        }

        const responseBody = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(responseBody));
                controller.close();
            },
        });
        
        return new Response(stream, {
            status,
            statusText,
            headers: responseHeaders,
        });
    } catch (error: any) {
        const errorMessage = error?.response?.data || error?.message || 'Request failed';
        const status = error?.response?.status || error?.status || 500;
        const errorBody = typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage);
        return new Response(errorBody, {
            status,
            statusText: error?.response?.statusText || errorMessage,
        });
    }
}

// Fetch через IPC команду в Rust для streaming запросов (обходит CORS полностью)
async function fetchWithTauriHttp(
    url: string,
    init: RequestInit,
    timeoutMs?: number
): Promise<Response> {
    const hasTimeout = typeof timeoutMs === 'number' && timeoutMs > 0;
    const timeoutSecs = hasTimeout ? Math.ceil(timeoutMs / 1000) : 600;

    const headers: Record<string, string> = {};
    if (init.headers) {
        if (init.headers instanceof Headers) {
            init.headers.forEach((value, key) => {
                headers[key] = value;
            });
        } else if (Array.isArray(init.headers)) {
            init.headers.forEach(([key, value]) => {
                headers[key] = value;
            });
        } else {
            Object.assign(headers, init.headers);
        }
    }

    const body = init.body ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : undefined;

    try {
        const {invoke} = await import('@tauri-apps/api/core');
        const responseText = await invoke<string>('ollama_http_request', {
            url,
            method: init.method || 'GET',
            headers,
            body,
            timeoutSecs,
        });

        // Для streaming создаем ReadableStream из данных
        // Ollama возвращает данные построчно, разбиваем на части
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    if (responseText) {
                        // Разбиваем на строки и отправляем по частям для имитации streaming
                        const lines = responseText.split('\n');
                        for (const line of lines) {
                            if (line.trim()) {
                                controller.enqueue(new TextEncoder().encode(line + '\n'));
                                await new Promise(resolve => setTimeout(resolve, 0));
                            }
                        }
                    }
                    controller.close();
                } catch (error) {
                    controller.error(error);
                }
            },
        });

        const responseHeaders = new Headers();
        responseHeaders.set('Content-Type', 'application/json');

        return new Response(stream, {
            status: 200,
            statusText: 'OK',
            headers: responseHeaders,
        });
    } catch (error: any) {
        // Обработка ошибок из Rust
        const errorMessage = error || 'Request failed';
        const status = error?.includes('HTTP 4') ? 400 : (error?.includes('HTTP 5') ? 500 : 500);
        return new Response(JSON.stringify({error: errorMessage}), {
            status,
            statusText: errorMessage,
        });
    }
}

export {fetchWithTimeout, ollamaAxios};
