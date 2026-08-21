import {useEffect, useRef, type ClipboardEvent, type KeyboardEvent} from 'react';
import {TextField} from '@mui/material';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import {createNewChat} from '../../ui/outputs';
import type {useRendererSession} from '../../hooks/useRendererSession';
import type {AppState} from '../../state/appState';
import {ChatHistory} from '../history/ChatHistory';
import {registerWaveCanvas} from '../../ui/waveform';
import {imagePreviewUrl} from '../../utils/promptImages';

type RendererController = ReturnType<typeof useRendererSession>;

type Props = {
    renderer: RendererController;
    appState: AppState;
    stopVisible: boolean;
    onOpenHistory: () => void;
};

function AudioInputIcon({type}: {type: RendererController['audioInput']}) {
    if (type === 'mixed') {
        return (
            <span className="audio-input-icons" aria-hidden="true">
                <img src="img/icons/mic.png" alt="" className="h-5 w-5"/>
                <img src="img/icons/audio.png" alt="" className="h-5 w-5"/>
            </span>
        );
    }
    return (
        <img
            id="toggleInputIcon"
            src={type === 'microphone' ? 'img/icons/mic.png' : 'img/icons/audio.png'}
            alt=""
            className="h-5 w-5"
            aria-hidden="true"
        />
    );
}

function audioInputTitle(type: RendererController['audioInput']): string {
    if (type === 'system') return 'Using system audio. Switch input';
    if (type === 'mixed') return 'Using microphone and system audio. Switch input';
    return 'Using microphone. Switch input';
}

function Waveform({visible}: {visible: boolean}) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    useEffect(() => {
        const canvas = canvasRef.current;
        return canvas ? registerWaveCanvas(canvas) : undefined;
    }, []);

    return (
        <div
            className={`${visible ? '' : 'hidden'} h-10 flex-1 overflow-hidden rounded-md`}
            style={{background: '#0001', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.02)'}}
            aria-hidden="true"
        >
            <canvas ref={canvasRef} className="h-full w-full"/>
        </div>
    );
}

export function MainWorkspace({renderer, appState, stopVisible, onOpenHistory}: Props) {
    const submitQuestion = () => {
        void renderer.sendQuestion();
    };
    const handleQuestionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
        event.preventDefault();
        if (!appState.isProcessing && (renderer.question.trim() || renderer.promptImages.length)) submitQuestion();
    };
    const handleQuestionPaste = (event: ClipboardEvent<HTMLDivElement>) => {
        const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
        if (!images.length) return;
        event.preventDefault();
        void renderer.addPastedImages(images);
    };

    return (
        <section className="flex flex-col gap-4 overflow-auto md:flex-row">
            <div className="card h-min flex-grow md:max-w-[340px] min-w-[305px]">
                {!renderer.settings.realtimeTranscription ? (
                    <div className={`send-last-container ${appState.isRecording ? 'expanded mb-2' : ''}`}>
                        <div className="label mb-2">Send the last:</div>
                        <div className="flex flex-wrap gap-2">
                            {renderer.settings.durations.map((seconds) => (
                                <button
                                    key={seconds}
                                    className="btn btn-secondary fcsc !px-1 !pb-1 !pt-0"
                                    type="button"
                                    onClick={() => void renderer.askWindow(seconds)}
                                >
                                    <span>{seconds}s</span>
                                    {renderer.settings.durationHotkeys[seconds] ? (
                                        <span className="hk text-xs text-gray-400 font-extralight">
                                            Ctrl-{String(renderer.settings.durationHotkeys[seconds]).toUpperCase()}
                                        </span>
                                    ) : null}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : null}

                <div className="mt-2 flex items-center gap-4">
                    <button
                        className="btn"
                        data-state={appState.isRecording ? 'rec' : 'idle'}
                        type="button"
                        aria-pressed={appState.isRecording}
                        disabled={!renderer.ready || appState.isProcessing}
                        onClick={() => void renderer.toggleRecording()}
                    >
                        {appState.isRecording ? 'Stop' : 'Start Audio Loop'}
                    </button>
                    <button
                        id="btnToggleInput"
                        type="button"
                        title={audioInputTitle(renderer.audioInput)}
                        aria-label={audioInputTitle(renderer.audioInput)}
                        disabled={!renderer.ready || renderer.audioSwitching}
                        onClick={() => void renderer.toggleAudio()}
                    >
                        <AudioInputIcon type={renderer.audioInput}/>
                    </button>
                    <Waveform visible={appState.isRecording}/>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        aria-label="Capture screenshot and attach"
                        title="Capture screenshot and attach"
                        disabled={!renderer.ready || appState.isProcessing}
                        onClick={() => void renderer.captureScreenshot()}
                    >
                        <img src="img/icons/image.png" alt="" className="h-5 w-5 invert" aria-hidden="true"/>
                    </button>
                </div>

                <div className="mt-2 flex flex-col">
                    {renderer.promptImages.length ? (
                        <div className="prompt-image-strip" aria-label="Attached images">
                            {renderer.promptImages.map((image) => (
                                <div className="prompt-image" key={image.id}>
                                    <img src={imagePreviewUrl(image)} alt={image.name || 'Attached image'}/>
                                    <button
                                        type="button"
                                        className="prompt-image__remove"
                                        aria-label={`Remove ${image.name || 'attached image'}`}
                                        title="Remove image"
                                        onClick={() => renderer.removePromptImage(image.id)}
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    <TextField
                        value={renderer.question}
                        onChange={(event) => renderer.setQuestion(event.target.value)}
                        onKeyDown={handleQuestionKeyDown}
                        onPaste={handleQuestionPaste}
                        placeholder="Ask a question..."
                        fullWidth
                        variant="outlined"
                        size="small"
                        multiline
                        minRows={1}
                        maxRows={7}
                        inputProps={{'aria-label': 'Question for the assistant'}}
                        sx={{
                            '& .MuiInputBase-root': {
                                alignItems: 'flex-start',
                                minHeight: '36px',
                                padding: '6px 10px',
                            },
                            '& .MuiInputBase-inputMultiline': {
                                padding: 0,
                                lineHeight: 1.45,
                            },
                        }}
                    />
                    <div className="mt-2 flex w-full flex-wrap items-center gap-2">
                        {stopVisible ? (
                            <button
                                className="btn btn-secondary !px-2 !py-1 text-xs"
                                type="button"
                                aria-label="Stop current operation"
                                onClick={() => void renderer.stopActive()}
                            >
                                Stop
                            </button>
                        ) : null}
                        <button
                            className="btn btn-secondary !px-2 !py-1 text-xs"
                            type="button"
                            onClick={() => createNewChat()}
                        >
                            New chat
                        </button>
                        <button
                            className="btn btn-secondary !px-2 !py-1 text-xs"
                            type="button"
                            aria-haspopup="dialog"
                            onClick={onOpenHistory}
                        >
                            History
                        </button>
                        <button
                            type="button"
                            className="btn btn-primary ml-auto inline-flex items-center gap-1 !px-2 !py-1 text-xs"
                            disabled={!renderer.ready || appState.isProcessing || (!renderer.question.trim() && !renderer.promptImages.length)}
                            aria-label="Send question"
                            onClick={submitQuestion}
                        >
                            <SendRoundedIcon aria-hidden="true" sx={{fontSize: 14}}/>
                            <span>Send</span>
                        </button>
                    </div>
                </div>
            </div>

            <div className="card flex flex-grow flex-col overflow-y-auto">
                <div className="label mb-2">Conversation</div>
                <ChatHistory/>
            </div>
        </section>
    );
}
