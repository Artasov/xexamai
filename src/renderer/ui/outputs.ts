import {marked} from 'marked';
import {addErrorHelpStyles, formatError} from '../utils/errorFormatter';
import type {ChatHistoryMessage} from '@shared/ipc';
import {buildHistoryScope, scopedHistoryStorageKey} from './historyScope';
import {
    isChatProvider,
    isChatSource,
    type ChatProvider,
    type ChatSource,
} from './chatMetadata';

if (typeof document !== 'undefined') addErrorHelpStyles();

export type ChatRole = 'user' | 'assistant' | 'error' | 'system';

export type ChatMessage = {
    id: string;
    role: ChatRole;
    text: string;
    pending?: boolean;
    retryText?: string;
    interrupted?: boolean;
    source?: ChatSource;
    provider?: ChatProvider;
    createdAt: number;
};

type ChatSession = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ChatMessage[];
    pinned: boolean;
};

export type ChatSessionSummary = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    pinned: boolean;
    interrupted: boolean;
    sources: ChatSource[];
    providers: ChatProvider[];
};

export type ChatMessageMetadata = {
    source?: ChatSource;
    provider?: ChatProvider;
};

export type ChatViewSnapshot = {
    chatId: string;
    messages: ChatMessage[];
};

type ChatSessionListener = (sessions: ChatSessionSummary[], activeChatId: string) => void;

let messageSeq = 0;

const CHAT_STORAGE_KEY = 'xexamai.chat.sessions.v1';
const CHAT_RETENTION_KEY = 'xexamai.chat.retention-days.v1';
const MAX_CHAT_SESSIONS = 100;
const MAX_MESSAGES_PER_CHAT = 300;
const DEFAULT_RETENTION_DAYS = 90;
const PERSIST_DEBOUNCE_MS = 250;

let sessionsHydrated = false;
let chatSessions: ChatSession[] = [];
let activeChatId: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let historyScope = buildHistoryScope('https://xlartas.com', null);
let historyPersistenceEnabled = false;

const chatSessionListeners = new Set<ChatSessionListener>();
const chatViewListeners = new Set<() => void>();
let chatViewSnapshot: ChatViewSnapshot = {chatId: '', messages: []};
let chatRenderFrame: number | null = null;
let sessionNotifyFrame: number | null = null;
export const CHAT_RETRY_EVENT_NAME = 'xexamai:chat-retry';

const currentChatStorageKey = (): string =>
    scopedHistoryStorageKey(CHAT_STORAGE_KEY, historyScope);
const currentRetentionStorageKey = (): string =>
    scopedHistoryStorageKey(CHAT_RETENTION_KEY, historyScope);

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

export function renderChatMarkdown(value: string): string {
    return sanitizeHtml(marked.parse(value, {async: false}) as string);
}

function normalizeChatMessage(raw: unknown): ChatMessage | null {
    if (!raw || typeof raw !== 'object') return null;
    const input = raw as Record<string, unknown>;
    const text = typeof input.text === 'string' ? input.text : '';
    const interrupted = Boolean(input.pending) || input.interrupted === true;
    const role = interrupted ? 'error' : sanitizeRole(input.role);
    const interruptedMarker = '[Interrupted — retry to continue]';
    const interruptedText = interrupted
        ? text.includes(interruptedMarker)
            ? text
            : `${text && text !== 'Syncing...' ? `${text}\n\n` : ''}${interruptedMarker}`
        : text;
    return {
        id: typeof input.id === 'string' && input.id ? input.id : nextMessageId(),
        role,
        text: interruptedText,
        pending: false,
        retryText: typeof input.retryText === 'string' ? input.retryText : undefined,
        interrupted,
        source: isChatSource(input.source) ? input.source : undefined,
        provider: isChatProvider(input.provider) ? input.provider : undefined,
        createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
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
        pinned: input.pinned === true,
    };
}

function isHistoryRole(
    message: ChatMessage
): message is ChatMessage & { role: 'user' | 'assistant' } {
    return message.role === 'user' || message.role === 'assistant';
}

function retentionDays(): number {
    if (!historyPersistenceEnabled) return DEFAULT_RETENTION_DAYS;
    const stored = window.localStorage?.getItem(currentRetentionStorageKey());
    if (stored == null) return DEFAULT_RETENTION_DAYS;
    const raw = Number(stored);
    return [0, 30, 90, 365].includes(raw) ? raw : DEFAULT_RETENTION_DAYS;
}

function pruneSessions(): void {
    const days = retentionDays();
    const cutoff = days === 0 ? 0 : Date.now() - days * 86_400_000;
    chatSessions = chatSessions
        .filter((session) => session.pinned || !cutoff || session.updatedAt >= cutoff || session.id === activeChatId)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
        .slice(0, MAX_CHAT_SESSIONS);
    for (const session of chatSessions) {
        if (session.messages.length > MAX_MESSAGES_PER_CHAT) {
            session.messages = session.messages.slice(-MAX_MESSAGES_PER_CHAT);
        }
    }
}

function writeSessions(): void {
    if (typeof window === 'undefined' || !historyPersistenceEnabled) return;
    try {
        pruneSessions();
        const payload = {
            activeChatId,
            sessions: chatSessions,
        };
        window.localStorage?.setItem(currentChatStorageKey(), JSON.stringify(payload));
    } catch (error) {
        // Quota recovery is progressive: keep pinned/current chats, then reduce
        // old sessions and long message lists before giving up.
        const ordered = [...chatSessions]
            .sort((a, b) => Number(b.pinned || b.id === activeChatId) - Number(a.pinned || a.id === activeChatId)
                || b.updatedAt - a.updatedAt);
        const attempts = [
            ordered.slice(0, Math.max(1, Math.ceil(ordered.length / 2))),
            ordered.slice(0, Math.max(1, Math.ceil(ordered.length / 3))).map((session) => ({
                ...session,
                messages: session.messages.slice(-100),
            })),
            ordered.filter((session) => session.pinned || session.id === activeChatId).map((session) => ({
                ...session,
                messages: session.messages.slice(-40),
            })),
        ];
        for (const candidate of attempts) {
            if (!candidate.length) continue;
            try {
                window.localStorage?.setItem(currentChatStorageKey(), JSON.stringify({activeChatId, sessions: candidate}));
                chatSessions = candidate;
                return;
            } catch {
            }
        }
        console.warn('[history] Could not persist chat history', error);
    }
}

function persistSessions(immediate = false): void {
    if (persistTimer) clearTimeout(persistTimer);
    if (!historyPersistenceEnabled) {
        persistTimer = null;
        return;
    }
    if (immediate) {
        persistTimer = null;
        writeSessions();
        return;
    }
    persistTimer = setTimeout(() => {
        persistTimer = null;
        writeSessions();
    }, PERSIST_DEBOUNCE_MS);
}

if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => persistSessions(true));
    window.addEventListener('beforeunload', () => persistSessions(true));
}

function hydrateSessions(): void {
    if (sessionsHydrated) return;
    sessionsHydrated = true;

    if (typeof window === 'undefined' || !historyPersistenceEnabled) {
        const session: ChatSession = {
            id: nextChatId(),
            title: initialChatTitle(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
            pinned: false,
        };
        chatSessions = [session];
        activeChatId = session.id;
        return;
    }

    try {
        const raw = window.localStorage?.getItem(currentChatStorageKey());
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
        try {
            const damaged = window.localStorage?.getItem(currentChatStorageKey());
            if (damaged) {
                window.localStorage?.setItem(`${currentChatStorageKey()}.corrupt.${Date.now()}`, damaged.slice(0, 1_000_000));
            }
        } catch {
        }
        const session: ChatSession = {
            id: nextChatId(),
            title: initialChatTitle(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
            pinned: false,
        };
        chatSessions = [session];
        activeChatId = session.id;
        persistSessions(true);
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
            pinned: false,
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

function commitChatView(): void {
    chatRenderFrame = null;
    const session = getActiveSession();
    chatViewSnapshot = {
        chatId: session.id,
        messages: session.messages.map((message) => ({...message})),
    };
    for (const listener of [...chatViewListeners]) {
        try {
            listener();
        } catch {
        }
    }
}

function renderChat(): void {
    if (chatRenderFrame !== null) return;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        chatRenderFrame = window.requestAnimationFrame(commitChatView);
        return;
    }
    commitChatView();
}

export function getChatViewSnapshot(): ChatViewSnapshot {
    hydrateSessions();
    if (!chatViewSnapshot.chatId) commitChatView();
    return chatViewSnapshot;
}

export function subscribeChatView(listener: () => void): () => void {
    chatViewListeners.add(listener);
    return () => chatViewListeners.delete(listener);
}

function commitChatSessionsChanged(): void {
    sessionNotifyFrame = null;
    const activeId = getActiveSession().id;
    const sessions = listChatSessions();
    for (const listener of chatSessionListeners) {
        try {
            listener(sessions, activeId);
        } catch {
        }
    }
}

function notifyChatSessionsChanged(): void {
    if (sessionNotifyFrame !== null) return;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        sessionNotifyFrame = window.requestAnimationFrame(commitChatSessionsChanged);
        return;
    }
    commitChatSessionsChanged();
}

export function listChatSessions(): ChatSessionSummary[] {
    hydrateSessions();
    return [...chatSessions]
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
        .map((session) => ({
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: session.messages.length,
            pinned: session.pinned,
            interrupted: session.messages.some((message) => message.interrupted),
            sources: getSessionSources(session),
            providers: getSessionProviders(session),
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
        pinned: false,
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
    options?: {
        id?: string;
        pending?: boolean;
        chatId?: string;
        retryText?: string;
        source?: ChatSource;
        provider?: ChatProvider;
    }
): string {
    const session = getSessionById(options?.chatId ?? null);
    const id = options?.id || nextMessageId();
    const entry: ChatMessage = {
        id,
        role,
        text: text || '',
        pending: options?.pending ?? false,
        retryText: options?.retryText?.trim() || undefined,
        interrupted: false,
        source: options?.source,
        provider: options?.provider,
        createdAt: Date.now(),
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

    const selected = messages.slice(-Math.max(1, maxTurns) * 2);
    return selected.map((message) => ({
        role: message.role === 'user' ? 'user' as const : 'assistant' as const,
        content: message.text.trim(),
    }));
}

export function setChatHistoryScope(
    accountId: number | null,
    backendOrigin: string,
    persistenceEnabled = false,
): void {
    const nextScope = buildHistoryScope(backendOrigin, accountId);
    if (nextScope === historyScope && persistenceEnabled === historyPersistenceEnabled) return;
    if (sessionsHydrated && historyPersistenceEnabled) persistSessions(true);
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    historyScope = nextScope;
    historyPersistenceEnabled = persistenceEnabled;
    sessionsHydrated = false;
    chatSessions = [];
    activeChatId = null;
    // The old unscoped format has no ownership metadata. Never attach it to the
    // next signed-in account on a shared Windows profile.
    try {
        window.localStorage?.removeItem(CHAT_STORAGE_KEY);
        window.localStorage?.removeItem(CHAT_RETENTION_KEY);
    } catch {
    }
    hydrateSessions();
    renderChat();
    notifyChatSessionsChanged();
}

function getSessionSources(session: ChatSession): ChatSource[] {
    const sources = new Set<ChatSource>();
    for (const message of session.messages) {
        if (message.source) sources.add(message.source);
        else if (/\[Screenshot\b/i.test(message.text)) sources.add('screenshot');
        else if (message.role === 'system' && /\b(?:audio|transcription|last\s+\d)/i.test(message.text)) sources.add('audio');
        else if (message.role === 'user') sources.add('text');
    }
    return [...sources];
}

function getSessionProviders(session: ChatSession): ChatProvider[] {
    const providers = new Set<ChatProvider>();
    for (const message of session.messages) {
        if (message.provider) {
            providers.add(message.provider);
            continue;
        }
        // Backwards-compatible inference for screenshot markers written before
        // explicit message metadata existed. Ordinary message text is not
        // inspected, avoiding false provider matches in interview content.
        if (!/\[Screenshot\b/i.test(message.text)) continue;
        if (/sent to Google\b/i.test(message.text)) providers.add('google');
        if (/sent to OpenAI\b/i.test(message.text)) providers.add('openai');
    }
    return [...providers];
}

export function searchChatSessions(query = '', pinnedOnly = false): ChatSessionSummary[] {
    hydrateSessions();
    const normalized = query.trim().toLocaleLowerCase();
    const ids = new Set(chatSessions
        .filter((session) => !pinnedOnly || session.pinned)
        .filter((session) => !normalized || session.title.toLocaleLowerCase().includes(normalized)
            || session.messages.some((message) => message.text.toLocaleLowerCase().includes(normalized)))
        .map((session) => session.id));
    return listChatSessions().filter((session) => ids.has(session.id));
}

export function renameChat(chatId: string, title: string): boolean {
    const session = getSessionById(chatId);
    const normalized = title.trim().slice(0, 120);
    if (!normalized || session.id !== chatId) return false;
    session.title = normalized;
    session.updatedAt = Date.now();
    persistSessions();
    notifyChatSessionsChanged();
    return true;
}

export function toggleChatPinned(chatId: string): boolean {
    const session = chatSessions.find((item) => item.id === chatId);
    if (!session) return false;
    session.pinned = !session.pinned;
    session.updatedAt = Date.now();
    persistSessions();
    notifyChatSessionsChanged();
    return session.pinned;
}

export function deleteChat(chatId: string): boolean {
    hydrateSessions();
    const index = chatSessions.findIndex((session) => session.id === chatId);
    if (index < 0) return false;
    chatSessions.splice(index, 1);
    if (!chatSessions.length) {
        createNewChat();
        return true;
    }
    if (activeChatId === chatId) activeChatId = chatSessions[0].id;
    persistSessions();
    renderChat();
    notifyChatSessionsChanged();
    return true;
}

export function exportChat(chatId: string): string | null {
    const session = chatSessions.find((item) => item.id === chatId);
    if (!session) return null;
    const lines = [`# ${session.title}`, '', `Created: ${new Date(session.createdAt).toISOString()}`, ''];
    for (const message of session.messages) {
        lines.push(`## ${message.role}`, '', message.text, '');
    }
    return lines.join('\n');
}

export function setChatRetentionDays(days: number): void {
    if (!historyPersistenceEnabled) return;
    const normalized = [0, 30, 90, 365].includes(days) ? days : DEFAULT_RETENTION_DAYS;
    window.localStorage?.setItem(currentRetentionStorageKey(), String(normalized));
    pruneSessions();
    persistSessions(true);
    renderChat();
    notifyChatSessionsChanged();
}

export function getChatRetentionDays(): number {
    return retentionDays();
}

export function beginRetryChatMessage(chatId: string, messageId: string): {
    chatId: string;
    userText: string;
    userMessageId: string;
    assistantMessageId: string;
    source?: ChatSource;
    provider?: ChatProvider;
} | null {
    const session = chatSessions.find((item) => item.id === chatId);
    if (!session) return null;
    const index = session.messages.findIndex((message) => message.id === messageId);
    const message = session.messages[index];
    const userText = message?.retryText?.trim();
    if (!message || !userText) return null;
    const priorUser = [...session.messages.slice(0, index)].reverse()
        .find((candidate) => candidate.role === 'user' && candidate.text.trim() === userText);
    message.role = 'assistant';
    message.text = 'Syncing...';
    message.pending = true;
    message.interrupted = false;
    message.retryText = undefined;
    session.updatedAt = Date.now();
    activeChatId = session.id;
    persistSessions();
    renderChat();
    notifyChatSessionsChanged();
    return {
        chatId: session.id,
        userText,
        userMessageId: priorUser?.id || '',
        assistantMessageId: message.id,
        source: message.source || priorUser?.source,
        provider: message.provider || priorUser?.provider,
    };
}

export function showText(text: string, chatId?: string, metadata?: ChatMessageMetadata) {
    if (text?.trim()) {
        appendChatMessage('user', text, {chatId, ...metadata});
    }
}

export function showAnswer(text: string, chatId?: string, metadata?: ChatMessageMetadata) {
    if (text?.trim()) {
        appendChatMessage('assistant', text, {chatId, ...metadata});
    }
}

export function showError(error: unknown, chatId?: string, metadata?: ChatMessageMetadata) {
    const formattedError = formatError(error);
    appendChatMessage('error', formattedError.displayText, {chatId, ...metadata});
}
