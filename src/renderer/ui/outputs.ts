import {marked} from 'marked';
import {addErrorHelpStyles, formatError} from '../utils/errorFormatter';
import type {ChatHistoryMessage} from '@shared/ipc';

addErrorHelpStyles();

type ChatRole = 'user' | 'assistant' | 'error' | 'system';

type ChatMessage = {
    id: string;
    role: ChatRole;
    text: string;
    pending?: boolean;
    retryText?: string;
};

type ChatSession = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ChatMessage[];
};

export type ChatSessionSummary = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
};

type ChatSessionListener = (sessions: ChatSessionSummary[], activeChatId: string) => void;

let textOut: HTMLDivElement | null = null;
let answerOut: HTMLDivElement | null = null;
let chatOut: HTMLDivElement | null = null;
let messageSeq = 0;

const CHAT_STORAGE_KEY = 'xexamai.chat.sessions.v1';

let sessionsHydrated = false;
let chatSessions: ChatSession[] = [];
let activeChatId: string | null = null;

const chatSessionListeners = new Set<ChatSessionListener>();
export const CHAT_RETRY_EVENT_NAME = 'xexamai:chat-retry';

const nextMessageId = (): string => `msg-${Date.now()}-${++messageSeq}`;
const nextChatId = (): string => `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const initialChatTitle = (): string => `New chat ${new Date().toLocaleString()}`;

function sanitizeRole(value: unknown): ChatRole {
    if (value === 'user' || value === 'assistant' || value === 'error' || value === 'system') {
        return value;
    }
    return 'system';
}

const ALLOWED_HTML_TAGS = new Set([
    'A',
    'BLOCKQUOTE',
    'BR',
    'CODE',
    'DEL',
    'DIV',
    'EM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HR',
    'LI',
    'OL',
    'P',
    'PRE',
    'SPAN',
    'STRONG',
    'TABLE',
    'TBODY',
    'TD',
    'TH',
    'THEAD',
    'TR',
    'UL',
]);

const DROP_HTML_TAGS = new Set(['IFRAME', 'IMG', 'MATH', 'OBJECT', 'SCRIPT', 'STYLE', 'SVG']);

function isSafeHtmlUrl(value: string): boolean {
    try {
        const url = new URL(value, window.location.origin);
        return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
    } catch {
        return false;
    }
}

function cleanElement(element: Element): void {
    const tagName = element.tagName.toUpperCase();
    if (DROP_HTML_TAGS.has(tagName)) {
        element.remove();
        return;
    }

    if (!ALLOWED_HTML_TAGS.has(tagName)) {
        for (const child of Array.from(element.children)) {
            cleanElement(child);
        }
        const parent = element.parentNode;
        if (!parent) return;
        while (element.firstChild) {
            parent.insertBefore(element.firstChild, element);
        }
        parent.removeChild(element);
        return;
    }

    for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const keepGlobal = name === 'class' || name === 'title';
        const keepLink = tagName === 'A' && ['href', 'target', 'rel'].includes(name);
        if (!keepGlobal && !keepLink) {
            element.removeAttribute(attribute.name);
            continue;
        }
        if (tagName === 'A' && name === 'href' && !isSafeHtmlUrl(attribute.value)) {
            element.removeAttribute(attribute.name);
        }
    }

    if (tagName === 'A' && element.getAttribute('href')) {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
    }

    for (const child of Array.from(element.children)) {
        cleanElement(child);
    }
}

function sanitizeHtml(html: string): string {
    const template = document.createElement('template');
    template.innerHTML = html;
    for (const child of Array.from(template.content.children)) {
        cleanElement(child);
    }
    return template.innerHTML;
}

function renderMarkdown(value: string): string {
    return sanitizeHtml(marked.parse(value, {async: false}) as string);
}

function escapeHtml(value: string): string {
    const div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
}

function normalizeChatMessage(raw: unknown): ChatMessage | null {
    if (!raw || typeof raw !== 'object') return null;
    const input = raw as Record<string, unknown>;
    const text = typeof input.text === 'string' ? input.text : '';
    return {
        id: typeof input.id === 'string' && input.id ? input.id : nextMessageId(),
        role: sanitizeRole(input.role),
        text,
        pending: false,
        retryText: typeof input.retryText === 'string' ? input.retryText : undefined,
    };
}

function normalizeChatSession(raw: unknown): ChatSession | null {
    if (!raw || typeof raw !== 'object') return null;
    const input = raw as Record<string, unknown>;
    const createdAt = typeof input.createdAt === 'number' ? input.createdAt : Date.now();
    const updatedAt = typeof input.updatedAt === 'number' ? input.updatedAt : createdAt;
    const messagesRaw = Array.isArray(input.messages) ? input.messages : [];
    const messages = messagesRaw
        .map((item) => normalizeChatMessage(item))
        .filter((item): item is ChatMessage => !!item);

    return {
        id: typeof input.id === 'string' && input.id ? input.id : nextChatId(),
        title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : initialChatTitle(),
        createdAt,
        updatedAt,
        messages,
    };
}

function isHistoryRole(
    message: ChatMessage
): message is ChatMessage & { role: 'user' | 'assistant' } {
    return message.role === 'user' || message.role === 'assistant';
}

function persistSessions(): void {
    if (typeof window === 'undefined') return;
    try {
        const payload = {
            activeChatId,
            sessions: chatSessions.map((session) => ({
                ...session,
                messages: session.messages.map((message) => ({
                    ...message,
                    pending: false,
                })),
            })),
        };
        window.localStorage?.setItem(CHAT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
    }
}

function hydrateSessions(): void {
    if (sessionsHydrated) return;
    sessionsHydrated = true;

    if (typeof window === 'undefined') {
        const session: ChatSession = {
            id: nextChatId(),
            title: initialChatTitle(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
        };
        chatSessions = [session];
        activeChatId = session.id;
        return;
    }

    try {
        const raw = window.localStorage?.getItem(CHAT_STORAGE_KEY);
        if (!raw) {
            throw new Error('No chats in storage');
        }
        const parsed = JSON.parse(raw) as { sessions?: unknown[]; activeChatId?: string | null } | null;
        const sessionsRaw = Array.isArray(parsed?.sessions) ? parsed?.sessions : [];
        const normalized = sessionsRaw
            .map((item) => normalizeChatSession(item))
            .filter((item): item is ChatSession => !!item);

        if (!normalized.length) {
            throw new Error('No valid chats');
        }

        chatSessions = normalized;
        const candidateId = typeof parsed?.activeChatId === 'string' ? parsed.activeChatId : null;
        activeChatId = normalized.some((session) => session.id === candidateId)
            ? candidateId
            : normalized[0].id;
    } catch {
        const session: ChatSession = {
            id: nextChatId(),
            title: initialChatTitle(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
        };
        chatSessions = [session];
        activeChatId = session.id;
        persistSessions();
    }
}

function getActiveSession(): ChatSession {
    hydrateSessions();

    if (!chatSessions.length) {
        const session: ChatSession = {
            id: nextChatId(),
            title: initialChatTitle(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
        };
        chatSessions = [session];
        activeChatId = session.id;
        persistSessions();
        return session;
    }

    const active = chatSessions.find((session) => session.id === activeChatId);
    if (active) return active;

    activeChatId = chatSessions[0].id;
    persistSessions();
    return chatSessions[0];
}

function getSessionById(chatId?: string | null): ChatSession {
    hydrateSessions();
    if (chatId) {
        const session = chatSessions.find((item) => item.id === chatId);
        if (session) return session;
    }
    return getActiveSession();
}

function summarizeTitleFromMessage(text: string): string | null {
    const raw = text.trim();
    if (!raw) return null;
    const cleaned = raw.replace(/^\[Screenshot captured[^\]]*\]\s*/i, '').trim();
    const source = cleaned || raw;
    const firstLine = source.split(/\r?\n/)[0].trim();
    if (!firstLine) return null;
    if (firstLine.length <= 48) return firstLine;
    return `${firstLine.slice(0, 48).trimEnd()}...`;
}

function maybeUpdateSessionTitle(session: ChatSession, role: ChatRole, text: string): void {
    if (role !== 'user') return;
    if (!session.title.startsWith('New chat')) return;
    const title = summarizeTitleFromMessage(text);
    if (!title) return;
    session.title = title;
}

function resolveChatOut(): HTMLDivElement | null {
    const target = chatOut ?? (document.getElementById('chatOut') as HTMLDivElement | null);
    if (!target) return null;
    chatOut = target;
    return target;
}

function renderChat(): void {
    const target = resolveChatOut();
    if (!target) return;

    const session = getActiveSession();
    const chatMessages = session.messages;

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
            content.innerHTML = value ? renderMarkdown(value) : '';
        } else {
            content.textContent = message.text;
        }

        bubble.appendChild(content);

        const canRetry = message.role === 'error' &&
            typeof message.retryText === 'string' &&
            message.retryText.trim().length > 0;
        if (canRetry) {
            const actions = document.createElement('div');
            actions.className = 'chat-message__actions';

            const retryButton = document.createElement('button');
            retryButton.type = 'button';
            retryButton.className = 'chat-retry-btn';
            retryButton.textContent = 'Retry';
            retryButton.addEventListener('click', () => {
                if (typeof window === 'undefined') return;
                const payload = {
                    chatId: session.id,
                    messageId: message.id,
                    text: (message.retryText || '').trim(),
                };
                window.dispatchEvent(new CustomEvent(CHAT_RETRY_EVENT_NAME, {detail: payload}));
            });

            actions.appendChild(retryButton);
            bubble.appendChild(actions);
        }

        row.appendChild(bubble);
        target.appendChild(row);
    }

    if (isAtBottom) {
        target.scrollTop = target.scrollHeight;
    } else {
        target.scrollTop = currentScrollTop;
    }
}

function notifyChatSessionsChanged(): void {
    const activeId = getActiveSession().id;
    const sessions = listChatSessions();
    for (const listener of chatSessionListeners) {
        try {
            listener(sessions, activeId);
        } catch {
        }
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
    hydrateSessions();
    renderChat();
    notifyChatSessionsChanged();
}

export function listChatSessions(): ChatSessionSummary[] {
    hydrateSessions();
    return [...chatSessions]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((session) => ({
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: session.messages.length,
        }));
}

export function subscribeChatSessions(listener: ChatSessionListener): () => void {
    chatSessionListeners.add(listener);
    listener(listChatSessions(), getActiveSession().id);
    return () => {
        chatSessionListeners.delete(listener);
    };
}

export function getActiveChatId(): string {
    return getActiveSession().id;
}

export function switchChat(chatId: string): boolean {
    hydrateSessions();
    const exists = chatSessions.some((session) => session.id === chatId);
    if (!exists) return false;
    activeChatId = chatId;
    persistSessions();
    renderChat();
    notifyChatSessionsChanged();
    return true;
}

export function createNewChat(): string {
    hydrateSessions();
    const now = Date.now();
    const next: ChatSession = {
        id: nextChatId(),
        title: initialChatTitle(),
        createdAt: now,
        updatedAt: now,
        messages: [],
    };
    chatSessions.unshift(next);
    activeChatId = next.id;
    persistSessions();
    renderChat();
    notifyChatSessionsChanged();
    return next.id;
}

export function appendChatMessage(
    role: ChatRole,
    text: string,
    options?: { id?: string; pending?: boolean; chatId?: string; retryText?: string }
): string {
    const session = getSessionById(options?.chatId ?? null);
    const id = options?.id || nextMessageId();
    const entry: ChatMessage = {
        id,
        role,
        text: text || '',
        pending: options?.pending ?? false,
        retryText: options?.retryText?.trim() || undefined,
    };
    session.messages.push(entry);
    session.updatedAt = Date.now();
    maybeUpdateSessionTitle(session, role, entry.text);
    persistSessions();
    renderChat();
    notifyChatSessionsChanged();
    return id;
}

export function updateChatMessage(
    id: string,
    updates: Partial<Omit<ChatMessage, 'id'>>,
    options?: { chatId?: string }
): void {
    hydrateSessions();

    const sessions = options?.chatId
        ? chatSessions.filter((session) => session.id === options.chatId)
        : chatSessions;

    for (const session of sessions) {
        const idx = session.messages.findIndex((item) => item.id === id);
        if (idx < 0) continue;

        const next: ChatMessage = {
            ...session.messages[idx],
            ...updates,
        };
        session.messages[idx] = next;
        session.updatedAt = Date.now();
        maybeUpdateSessionTitle(session, next.role, next.text);
        persistSessions();
        renderChat();
        notifyChatSessionsChanged();
        return;
    }
}

export function clearChatHistory(chatId?: string): void {
    const session = getSessionById(chatId ?? null);
    session.messages = [];
    session.updatedAt = Date.now();
    session.title = initialChatTitle();
    persistSessions();
    renderChat();
    notifyChatSessionsChanged();
}

export function getConversationContext(chatId?: string, maxTurns = 20): ChatHistoryMessage[] {
    const session = getSessionById(chatId ?? null);
    const messages = session.messages
        .filter(isHistoryRole)
        .filter((message) => (
            !message.pending &&
            typeof message.text === 'string' &&
            message.text.trim().length > 0
        ));

    const sliced = messages.slice(-Math.max(1, maxTurns) * 2);
    return sliced.map((message) => ({
        role: message.role,
        content: message.text.trim(),
    }));
}

export function showText(text: string, chatId?: string) {
    const target = textOut ?? (document.getElementById('textOut') as HTMLDivElement | null);
    if (target) {
        textOut = target;
        target.textContent = text || '';
        return;
    }
    if (text?.trim()) {
        appendChatMessage('user', text, {chatId});
    }
}

export function showAnswer(text: string, chatId?: string) {
    const target = answerOut ?? (document.getElementById('answerOut') as HTMLDivElement | null);
    if (target) {
        answerOut = target;
        target.innerHTML = text ? renderMarkdown(text) : '';
        return;
    }
    if (text?.trim()) {
        appendChatMessage('assistant', text, {chatId});
    }
}

export function showError(error: unknown, chatId?: string) {
    const formattedError = formatError(error);
    const target = answerOut ?? (document.getElementById('answerOut') as HTMLDivElement | null);

    if (target) {
        answerOut = target;
        let errorHtml = `<div class="error-message">${escapeHtml(formattedError.displayText)}</div>`;
        if (formattedError.helpHtml) {
            errorHtml += sanitizeHtml(formattedError.helpHtml);
        }
        target.innerHTML = errorHtml;
        return;
    }

    appendChatMessage('error', formattedError.displayText, {chatId});
}
