import {useEffect, useMemo, useState} from 'react';
import {Drawer} from '@mui/material';
import {
    createNewChat,
    deleteChat,
    exportChat,
    getChatRetentionDays,
    renameChat,
    searchChatSessions,
    setChatRetentionDays,
    subscribeChatSessions,
    switchChat,
    toggleChatPinned,
    type ChatSessionSummary,
} from '../../ui/outputs';
import {setStatus} from '../../ui/status';
import type {ChatProvider} from '../../ui/chatMetadata';

type HistoryFilter = 'all' | 'pinned' | 'interrupted' | 'audio' | 'screenshot' | 'text';
type HistoryProviderFilter = 'all' | ChatProvider;

type Props = {
    open: boolean;
    onClose: () => void;
};

function downloadMarkdown(title: string, markdown: string): void {
    const blob = new Blob([markdown], {type: 'text/markdown;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 80) || 'chat'}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function metadataLabel(session: ChatSessionSummary): string {
    const sourceLabels = session.sources.map((source) => source === 'screenshot' ? 'Screenshot' : source === 'audio' ? 'Audio' : 'Text');
    const providerLabels = session.providers.map((provider) => {
        if (provider === 'openai') return 'OpenAI';
        if (provider === 'google') return 'Google';
        if (provider === 'winky') return 'Winky';
        return 'Ollama';
    });
    const labels = [...sourceLabels, ...providerLabels];
    return labels.length ? labels.join(' · ') : 'Empty';
}

export function HistoryDrawer({open, onClose}: Props) {
    const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
    const [activeId, setActiveId] = useState('');
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<HistoryFilter>('all');
    const [providerFilter, setProviderFilter] = useState<HistoryProviderFilter>('all');
    const [retention, setRetention] = useState(() => getChatRetentionDays());
    const [renameId, setRenameId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [deleteId, setDeleteId] = useState<string | null>(null);

    useEffect(() => subscribeChatSessions((next, nextActiveId) => {
        setSessions(next);
        setActiveId(nextActiveId);
        setRetention(getChatRetentionDays());
    }), []);

    const visible = useMemo(() => {
        let matching = searchChatSessions(query, filter === 'pinned');
        if (filter === 'interrupted') matching = matching.filter((session) => session.interrupted);
        if (filter === 'audio' || filter === 'screenshot' || filter === 'text') {
            matching = matching.filter((session) => session.sources.includes(filter));
        }
        return matching.filter((session) => providerFilter === 'all' || session.providers.includes(providerFilter));
    }, [filter, providerFilter, query, sessions]);

    const beginRename = (session: ChatSessionSummary) => {
        setRenameId(session.id);
        setRenameValue(session.title);
        setDeleteId(null);
    };

    const commitRename = () => {
        if (renameId && renameChat(renameId, renameValue)) setRenameId(null);
    };

    const exportSession = (session: ChatSessionSummary) => {
        const markdown = exportChat(session.id);
        if (!markdown) {
            setStatus('Could not export chat', 'error');
            return;
        }
        downloadMarkdown(session.title, markdown);
        setStatus('Chat exported as Markdown', 'ready');
    };

    return (
        <Drawer
            anchor="left"
            open={open}
            onClose={onClose}
            aria-labelledby="history-drawer-title"
            slotProps={{
                paper: {
                    sx: {
                        width: 'min(430px, 92vw)',
                        background: '#08090c',
                        color: '#f3f4f6',
                        borderRight: '1px solid #ffffff18',
                    },
                },
            }}
        >
            <section className="history-drawer" aria-label="Conversation history">
                <header className="history-drawer__header">
                    <div>
                        <h2 id="history-drawer-title">Conversation history</h2>
                        <p>Search, organize, and export saved conversations.</p>
                    </div>
                    <button type="button" className="btn btn-secondary" onClick={onClose} aria-label="Close history">
                        Close
                    </button>
                </header>

                <div className="history-drawer__toolbar">
                    <input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search titles and messages"
                        aria-label="Search conversation history"
                    />
                    <select value={filter} onChange={(event) => setFilter(event.target.value as HistoryFilter)} aria-label="Filter history by source or status">
                        <option value="all">All conversations</option>
                        <option value="pinned">Pinned</option>
                        <option value="interrupted">Interrupted</option>
                        <option value="audio">Audio source</option>
                        <option value="screenshot">Screenshot source</option>
                        <option value="text">Text source</option>
                    </select>
                    <select
                        value={providerFilter}
                        onChange={(event) => setProviderFilter(event.target.value as HistoryProviderFilter)}
                        aria-label="Filter history by AI provider"
                    >
                        <option value="all">All providers</option>
                        <option value="openai">OpenAI</option>
                        <option value="google">Google</option>
                        <option value="winky">Winky</option>
                        <option value="ollama">Ollama (local)</option>
                    </select>
                    <label>
                        Retention
                        <select
                            value={retention}
                            onChange={(event) => {
                                const days = Number(event.target.value);
                                setRetention(days);
                                setChatRetentionDays(days);
                            }}
                        >
                            <option value={30}>30 days</option>
                            <option value={90}>90 days</option>
                            <option value={365}>1 year</option>
                            <option value={0}>Forever</option>
                        </select>
                    </label>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                            createNewChat();
                            onClose();
                        }}
                    >
                        New chat
                    </button>
                </div>

                <div className="history-drawer__list" role="list">
                    {!visible.length ? <div className="history-drawer__empty">No conversations match this filter.</div> : null}
                    {visible.map((session) => (
                        <article
                            key={session.id}
                            className={`history-entry ${session.id === activeId ? 'history-entry--active' : ''}`}
                            role="listitem"
                        >
                            {renameId === session.id ? (
                                <form className="history-entry__rename" onSubmit={(event) => { event.preventDefault(); commitRename(); }}>
                                    <input
                                        value={renameValue}
                                        onChange={(event) => setRenameValue(event.target.value)}
                                        maxLength={120}
                                        aria-label="Conversation title"
                                        autoFocus
                                    />
                                    <button type="submit">Save</button>
                                    <button type="button" onClick={() => setRenameId(null)}>Cancel</button>
                                </form>
                            ) : (
                                <button
                                    type="button"
                                    className="history-entry__main"
                                    aria-current={session.id === activeId ? 'true' : undefined}
                                    onClick={() => {
                                        switchChat(session.id);
                                        onClose();
                                    }}
                                >
                                    <span className="history-entry__title">{session.pinned ? '★ ' : ''}{session.title}</span>
                                    <span className="history-entry__meta">
                                        {new Date(session.updatedAt).toLocaleString()} · {session.messageCount} messages
                                    </span>
                                    <span className="history-entry__source">
                                        {metadataLabel(session)}{session.interrupted ? ' · Interrupted' : ''}
                                    </span>
                                </button>
                            )}
                            <div className="history-entry__actions" aria-label={`Actions for ${session.title}`}>
                                <button type="button" onClick={() => toggleChatPinned(session.id)}>{session.pinned ? 'Unpin' : 'Pin'}</button>
                                <button type="button" onClick={() => beginRename(session)}>Rename</button>
                                <button type="button" onClick={() => exportSession(session)}>Export</button>
                                {deleteId === session.id ? (
                                    <>
                                        <button type="button" className="history-entry__delete" onClick={() => { deleteChat(session.id); setDeleteId(null); }}>Confirm</button>
                                        <button type="button" onClick={() => setDeleteId(null)}>Cancel</button>
                                    </>
                                ) : (
                                    <button type="button" className="history-entry__delete" onClick={() => { setDeleteId(session.id); setRenameId(null); }}>Delete</button>
                                )}
                            </div>
                        </article>
                    ))}
                </div>
            </section>
        </Drawer>
    );
}
