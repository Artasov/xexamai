// noinspection JSUnusedGlobalSymbols

import {Button, CircularProgress, IconButton, MenuItem, TextField, Typography} from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import type {LocalDevice} from '@shared/ipc';
import {formatTranscribeLabel} from './formatters';

type LocalModelState = {
    transcriptionMode: 'api' | 'local';
    localWhisperModel: string | undefined;
    localDevice: LocalDevice | undefined;
    localStatusReady: boolean;
    localModelReady: boolean | null;
    localModelError: string | null;
    localModelWarming: boolean;
    checkingLocalModel: boolean;
    downloadingLocalModel: boolean;
};

type LocalModelHandlers = {
    onChangeMode: (mode: 'api' | 'local') => void;
    onChangeModel: (model: string) => void;
    onChangeDevice: (device: LocalDevice) => void;
    onInstall: () => Promise<void>;
    onWarmup: () => Promise<void>;
    onRestart: () => Promise<void>;
    onStop: () => Promise<void>;
    onInfo: (type: 'transcribe' | 'llm') => void;
};

type LocalModelSectionProps = LocalModelState &
    LocalModelHandlers & {
    localModels: readonly string[];
    devices: readonly LocalDevice[];
};

export function LocalModelSection({
                                      transcriptionMode,
                                      localWhisperModel,
                                      localStatusReady,
                                      localModels,
                                      localModelReady,
                                      localModelError,
                                      localModelWarming,
                                      checkingLocalModel,
                                      downloadingLocalModel,
                                      localDevice,
                                      devices,
                                      onChangeMode,
                                      onChangeModel,
                                      onChangeDevice,
                                      onInstall,
                                      onWarmup,
                                      onRestart,
                                      onStop,
                                      onInfo,
                                  }: LocalModelSectionProps) {
    return (
        <section className="settings-card card">
            <div className="settings-card__header">
                <h3 className="settings-card__title">Speech to text</h3>
                <div className="settings-card__actions">
                    <Button
                        variant="outlined"
                        size="small"
                        color={transcriptionMode === 'local' ? 'secondary' : 'primary'}
                        onClick={() => onChangeMode(transcriptionMode === 'local' ? 'api' : 'local')}
                    >
                        {transcriptionMode === 'local' ? 'Switch to API' : 'Switch to Local'}
                    </Button>
                    <IconButton size="small" onClick={() => onInfo('transcribe')}>
                        <InfoOutlinedIcon fontSize="small"/>
                    </IconButton>
                </div>
            </div>

            <div className="ai-settings__grid">
                <div className="settings-field">
                    <TextField
                        label="Mode"
                        select
                        value={transcriptionMode}
                        onChange={(event) => onChangeMode(event.target.value as 'api' | 'local')}
                        fullWidth
                    >
                        <MenuItem value="api">API</MenuItem>
                        <MenuItem value="local">Local</MenuItem>
                    </TextField>
                </div>

                <div className="settings-field">
                    <TextField
                        label="Local model"
                        select
                        value={localWhisperModel || ''}
                        onChange={(event) => onChangeModel(event.target.value)}
                        fullWidth
                    >
                        {localModels.map((model) => (
                            <MenuItem key={model} value={model}>
                                {formatTranscribeLabel(model)}
                            </MenuItem>
                        ))}
                    </TextField>
                    <div className="settings-hint-row">
                        {checkingLocalModel ? <CircularProgress size={16}/> : null}
                        {localModelReady ? (
                            <span className="status-ok">
                                <CheckCircleIcon fontSize="small"/> Ready
                            </span>
                        ) : null}
                        {localModelWarming ? (
                            <span className="status-warmup">
                                <CircularProgress size={12}/> Warming up…
                            </span>
                        ) : null}
                        {localModelError ? <span className="status-error">{localModelError}</span> : null}
                    </div>
                </div>

                <div className="settings-field">
                    <TextField
                        label="Device"
                        select
                        value={localDevice || 'auto'}
                        onChange={(event) => onChangeDevice(event.target.value as LocalDevice)}
                        fullWidth
                    >
                        <MenuItem value="auto">Auto</MenuItem>
                        {devices.map((device) => (
                            <MenuItem key={device} value={device}>
                                {device}
                            </MenuItem>
                        ))}
                    </TextField>
                </div>

                <div className="settings-field settings-actions-row">
                    <Button
                        variant="contained"
                        color="primary"
                        onClick={onInstall}
                        disabled={downloadingLocalModel}
                        startIcon={downloadingLocalModel ? <CircularProgress size={14}/> : undefined}
                    >
                        {downloadingLocalModel ? 'Downloading…' : 'Install / Update'}
                    </Button>
                    <Button
                        variant="outlined"
                        color="secondary"
                        onClick={onWarmup}
                        disabled={!localStatusReady || downloadingLocalModel}
                        startIcon={localModelWarming ? <CircularProgress size={14}/> : <PlayArrowIcon/>}
                    >
                        Warm up
                    </Button>
                    <IconButton onClick={onRestart} disabled={!localStatusReady || downloadingLocalModel}>
                        <RestartAltIcon/>
                    </IconButton>
                    <IconButton onClick={onStop} disabled={!localStatusReady || downloadingLocalModel}>
                        <StopCircleIcon/>
                    </IconButton>
                </div>
                {!localStatusReady ? (
                    <Typography variant="caption" color="text.secondary">
                        Install and start the local service to enable offline transcription.
                    </Typography>
                ) : null}
            </div>
        </section>
    );
}
