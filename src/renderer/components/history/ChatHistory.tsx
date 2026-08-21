import {memo, useLayoutEffect, useMemo, useRef, useSyncExternalStore} from 'react';
import {
    CHAT_RETRY_EVENT_NAME,
    getChatViewSnapshot,
    renderChatMarkdown,
    subscribeChatView,
    type ChatMessage,
} from '../../ui/outputs';

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
            {snapshot.messages.map((message) => (
                <div key={message.id} className={`chat-row chat-row--${message.role}`} data-message-id={message.id}>
                    <div className={`chat-message chat-message--${message.role}`}>
                        <ChatContent message={message}/>
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
            ))}
        </div>
    );
}
