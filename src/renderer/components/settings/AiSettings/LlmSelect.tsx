// noinspection JSUnusedGlobalSymbols

import {MenuItem, TextField} from '@mui/material';
import type {LlmHost} from '@renderer/types';

type Option = { value: string; label: string; disabled?: boolean };

type Props = {
    host: LlmHost;
    model: string;
    options: Option[];
    onHostChange: (host: LlmHost) => void;
    onModelChange: (model: string) => void;
};

export function LlmSelect({host, model, options, onHostChange, onModelChange}: Props) {
    return (
        <>
            <div className="settings-field">
                <div className="ai-settings__select-wrapper">
                    <TextField
                        select
                        size="small"
                        fullWidth
                        label="LLM host"
                        value={host ?? 'api'}
                        onChange={(event) => onHostChange(event.target.value as LlmHost)}
                    >
                        {[
                            {value: 'api', label: 'API'},
                            {value: 'local', label: 'Local'},
                        ].map((option) => (
                            <MenuItem key={option.value} value={option.value}>
                                {option.label}
                            </MenuItem>
                        ))}
                    </TextField>
                </div>
            </div>

            <div className="settings-field">
                <div className="ai-settings__select-wrapper">
                    <TextField
                        select
                        size="small"
                        fullWidth
                        label="LLM model"
                        value={model}
                        onChange={(event) => onModelChange(event.target.value)}
                    >
                        {options.map((option) => (
                            <MenuItem key={option.value} value={option.value} disabled={option.disabled}>
                                {option.label}
                                {option.disabled ? ' (API key required)' : ''}
                            </MenuItem>
                        ))}
                    </TextField>
                </div>
            </div>
        </>
    );
}
