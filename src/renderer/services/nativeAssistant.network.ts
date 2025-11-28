const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit, timeoutMs?: number) => {
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
            userSignal.addEventListener('abort', abortHandler, { once: true });
        }
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (hasTimeout) {
        timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
    }

    try {
        return await fetch(input, { ...fetchOptions, signal: controller.signal });
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
};

export { fetchWithTimeout };
