import {AppConfig} from '../../config.service';
import {logger} from '../../logger.service';

const LOCAL_URL = 'http://localhost:11434/api/chat';

export async function askChatWithLocalModel(prompt: string, cfg: AppConfig): Promise<string> {
    const systemMessage = cfg.llmPrompt;

    logger.info('gpt-oss', 'Starting local chat completion', {
        promptLength: prompt.length,
        model: cfg.chatModel,
        url: LOCAL_URL,
        stream: false,
    });

    const res = await fetch(LOCAL_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            model: cfg.chatModel,
            messages: [
                {role: 'system', content: systemMessage},
                {role: 'user', content: prompt},
            ],
            stream: false,
        }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Local chat request failed: ${res.status} ${res.statusText} ${text}`);
    }

    const data: any = await res.json().catch(() => ({}));
    const msg = (data?.message?.content || data?.choices?.[0]?.message?.content || '').toString().trim();

    logger.info('gpt-oss', 'Local chat completion finished', {
        responseLength: msg.length,
        model: cfg.chatModel,
    });

    return msg;
}

export async function askChatStreamWithLocalModel(
    prompt: string,
    cfg: AppConfig,
    onDelta: (delta: string) => void,
    options?: { signal?: AbortSignal; shouldCancel?: () => boolean }
): Promise<void> {
    const systemMessage = cfg.llmPrompt;

    logger.info('gpt-oss', 'Starting local chat stream', {
        promptLength: prompt.length,
        model: cfg.chatModel,
        url: LOCAL_URL,
        stream: true,
    });

    const res = await fetch(LOCAL_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            model: cfg.chatModel,
            messages: [
                {role: 'system', content: systemMessage},
                {role: 'user', content: prompt},
            ],
            stream: true,
        }),
        signal: options?.signal,
    });

    if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`Local chat stream failed: ${res.status} ${res.statusText} ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
        while (true) {
            if (options?.shouldCancel?.()) break;
            const {done, value} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                if (options?.shouldCancel?.()) { buffer = ''; break; }
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line) continue;
                try {
                    const obj = JSON.parse(line);
                    const delta = (obj?.message?.content ?? obj?.delta ?? obj?.choices?.[0]?.delta?.content ?? '') + '';
                    if (delta) onDelta(delta);
                } catch {
                }
            }
        }
        const rest = buffer.trim();
        if (rest) {
            try {
                const obj = JSON.parse(rest);
                const delta = (obj?.message?.content ?? obj?.delta ?? '') + '';
                if (delta) onDelta(delta);
            } catch {
            }
        }
    } finally {
        logger.info('gpt-oss', 'Local chat stream completed', {model: cfg.chatModel});
    }
}
