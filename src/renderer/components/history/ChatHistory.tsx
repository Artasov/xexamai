import {memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {
    CHAT_RETRY_EVENT_NAME,
    getChatViewSnapshot,
    renderChatMarkdown,
    subscribeChatView,
    type ChatMessage,
} from '../../ui/outputs';
import {resolveThinkingLanguage, THINKING_LABELS} from '../../utils/thinkingStatus';

const THINKING_PHASE_INTERVAL_MS = 1_600;

function ThinkingStatus({source}: {source?: string}) {
    const uiLanguage = typeof document === 'undefined' ? undefined : document.documentElement.lang;
    const language = resolveThinkingLanguage(source, uiLanguage);
    const labels = THINKING_LABELS[language];
    const [phase, setPhase] = useState(0);

    useEffect(() => {
        setPhase(0);
        const timer = window.setInterval(() => {
            setPhase((current) => (current + 1) % labels.length);
        }, THINKING_PHASE_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [labels]);

    return (
        <div
            className="chat-thinking"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={language === 'ru' ? 'Подготавливаю ответ' : 'Preparing response'}
        >
            <span key={phase} className="chat-thinking__label" aria-hidden="true">
                {labels[phase]}
            </span>
        </div>
    );
}

const isThinkingPlaceholder = (message: ChatMessage): boolean => (
    message.role === 'assistant'
    && message.pending === true
    && (!message.text.trim() || message.text === 'Syncing...')
);

const ChatContent = memo(function ChatContent({message}: {message: ChatMessage}) {
    const html = useMemo(() => {
        if (message.role !== 'assistant') return '';
        const value = message.text || (message.pending ? 'Syncing...' : '');
        return value ? renderChatMarkdown(value) : '';
    }, [message.pending, message.role, message.text]);
    if (message.role !== 'assistant') {
        return <div className="chat-message__content">{message.text}</div>;
    }
    return (
        <div
            className="chat-message__content chat-markdown"
            dangerouslySetInnerHTML={{__html: html}}
        />
    );
}, (previous, next) => (
    previous.message.role === next.message.role
    && previous.message.text === next.message.text
    && previous.message.pending === next.message.pending
));

export function ChatHistory() {
    const snapshot = useSyncExternalStore(subscribeChatView, getChatViewSnapshot, getChatViewSnapshot);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const stickToBottomRef = useRef(true);

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (container && stickToBottomRef.current) container.scrollTop = container.scrollHeight;
    }, [snapshot]);

    return (
        <div
            ref={containerRef}
            className="chat-history enable-tap-select-text flex-grow overflow-auto"
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            aria-busy={snapshot.messages.some((message) => message.pending)}
            onScroll={(event) => {
                const target = event.currentTarget;
                stickToBottomRef.current = target.scrollTop + target.clientHeight >= target.scrollHeight - 12;
            }}
        >
            {snapshot.messages.map((message, index) => {
                const thinking = isThinkingPlaceholder(message);
                const languageSource = message.retryText || [...snapshot.messages.slice(0, index)]
                    .reverse()
                    .find((candidate) => candidate.role === 'user')?.text;
                return (
                    <div key={message.id} className={`chat-row chat-row--${message.role}`} data-message-id={message.id}>
                        <div className={`chat-message chat-message--${message.role}${thinking ? ' chat-message--pending' : ''}`}>
                            {thinking
                                ? <ThinkingStatus source={languageSource}/>
                                : <ChatContent message={message}/>}
                            {message.role === 'error' && message.retryText?.trim() ? (
                                <div className="chat-message__actions">
                                    <button
                                        type="button"
                                        className="chat-retry-btn"
                                        onClick={() => window.dispatchEvent(new CustomEvent(CHAT_RETRY_EVENT_NAME, {
                                            detail: {
                                                chatId: snapshot.chatId,
                                                messageId: message.id,
                                                text: message.retryText?.trim(),
                                            },
                                        }))}
                                    >
                                        Retry
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
