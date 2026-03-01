import {marked} from 'marked';
import {addErrorHelpStyles, formatError} from '../utils/errorFormatter';

addErrorHelpStyles();

type ChatRole = 'user' | 'assistant' | 'error' | 'system';

type ChatMessage = {
    id: string;
    role: ChatRole;
    text: string;
    pending?: boolean;
};

let textOut: HTMLDivElement | null = null;
let answerOut: HTMLDivElement | null = null;
let chatOut: HTMLDivElement | null = null;
let messageSeq = 0;
const chatMessages: ChatMessage[] = [];

const nextMessageId = (): string => `msg-${Date.now()}-${++messageSeq}`;

function resolveChatOut(): HTMLDivElement | null {
    const target = chatOut ?? (document.getElementById('chatOut') as HTMLDivElement | null);
    if (!target) return null;
    chatOut = target;
    return target;
}

function renderChat(): void {
    const target = resolveChatOut();
    if (!target) return;

    const currentScrollTop = target.scrollTop;
    const currentScrollHeight = target.scrollHeight;
    const isAtBottom = currentScrollTop + target.clientHeight >= currentScrollHeight - 8;

    target.innerHTML = '';

    for (const message of chatMessages) {
        const row = document.createElement('div');
        row.className = `chat-row chat-row--${message.role}`;

        const bubble = document.createElement('div');
        bubble.className = `chat-message chat-message--${message.role}`;

        const content = document.createElement('div');
        content.className = `chat-message__content ${message.role === 'assistant' ? 'chat-markdown' : ''}`;

        if (message.role === 'assistant') {
            const value = message.text || (message.pending ? 'Syncing...' : '');
            content.innerHTML = value ? (marked.parse(value, {async: false}) as string) : '';
        } else {
            content.textContent = message.text;
        }

        bubble.appendChild(content);
        row.appendChild(bubble);
        target.appendChild(row);
    }

    if (isAtBottom) {
        target.scrollTop = target.scrollHeight;
    } else {
        target.scrollTop = currentScrollTop;
    }
}

export function initOutputs(elements: {
    text?: HTMLDivElement | null;
    answer?: HTMLDivElement | null;
    chat?: HTMLDivElement | null;
}) {
    if (typeof elements !== 'object' || !elements) return;
    if (elements.text) textOut = elements.text;
    if (elements.answer) answerOut = elements.answer;
    if (elements.chat) chatOut = elements.chat;
}

export function appendChatMessage(
    role: ChatRole,
    text: string,
    options?: { id?: string; pending?: boolean }
): string {
    const id = options?.id || nextMessageId();
    chatMessages.push({
        id,
        role,
        text: text || '',
        pending: options?.pending ?? false,
    });
    renderChat();
    return id;
}

export function updateChatMessage(id: string, updates: Partial<Omit<ChatMessage, 'id'>>): void {
    const idx = chatMessages.findIndex((item) => item.id === id);
    if (idx < 0) return;
    chatMessages[idx] = {
        ...chatMessages[idx],
        ...updates,
    };
    renderChat();
}

export function clearChatHistory(): void {
    chatMessages.length = 0;
    const target = resolveChatOut();
    if (target) {
        target.innerHTML = '';
    }
}

export function showText(text: string) {
    const target = textOut ?? (document.getElementById('textOut') as HTMLDivElement | null);
    if (target) {
        textOut = target;
        target.textContent = text || '';
        return;
    }
    if (text?.trim()) {
        appendChatMessage('user', text);
    }
}

export function showAnswer(text: string) {
    const target = answerOut ?? (document.getElementById('answerOut') as HTMLDivElement | null);
    if (target) {
        answerOut = target;
        target.innerHTML = text ? (marked.parse(text, {async: false}) as string) : '';
        return;
    }
    if (text?.trim()) {
        appendChatMessage('assistant', text);
    }
}

export function showError(error: unknown) {
    const formattedError = formatError(error);
    const target = answerOut ?? (document.getElementById('answerOut') as HTMLDivElement | null);

    if (target) {
        answerOut = target;
        let errorHtml = `<div class="error-message">${formattedError.displayText}</div>`;
        if (formattedError.helpHtml) {
            errorHtml += formattedError.helpHtml;
        }
        target.innerHTML = errorHtml;
        return;
    }

    appendChatMessage('error', formattedError.displayText);
}
