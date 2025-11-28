import {MenuItem, TextField} from '@mui/material';

type Option = { value: string; label: string; disabled?: boolean; description?: string };

type Props = {
    label: string;
    value: string;
    options: Option[];
    onChange: (value: string) => void;
};

export function ApiModelSelect({label, value, options, onChange}: Props) {
    return (
        <div className="settings-field">
            <div className="ai-settings__select-wrapper">
                <TextField
                    select
                    size="small"
                    fullWidth
                    label={label}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                >
                    {options.map((option) => {
                        const hint = option.description || (option.disabled ? 'API key required' : '');
                        return (
                            <MenuItem key={option.value} value={option.value} disabled={option.disabled}>
                                {option.label}
                                {hint ? ` (${hint})` : ''}
                            </MenuItem>
                        );
                    })}
                </TextField>
            </div>
        </div>
    );
}
