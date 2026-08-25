import {
    CircularProgress,
    IconButton,
    InputAdornment,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PublishedWithChangesOutlinedIcon from '@mui/icons-material/PublishedWithChangesOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import {useState} from 'react';
import {
    getProviderKeyFieldState,
    normalizeProviderKeyDraftInput,
} from './providerKeyFieldState';

type Provider = 'openai' | 'google';

type ProviderKeyFieldProps = {
    provider: Provider;
    label: string;
    value: string;
    saved: boolean;
    testing: boolean;
    testMessage: string;
    onChange: (value: string) => void;
    onSave: (value: string) => Promise<void>;
    onTest: (provider: Provider) => Promise<void>;
};

function ProviderKeyField({
    provider,
    label,
    value,
    saved,
    testing,
    testMessage,
    onChange,
    onSave,
    onTest,
}: ProviderKeyFieldProps) {
    const [editing, setEditing] = useState(false);
    const fieldState = getProviderKeyFieldState({draft: value, saved, editing});

    return (
        <div className="settings-field">
            <TextField
                label={label}
                type="password"
                size="small"
                value={fieldState.displayValue}
                placeholder={fieldState.placeholder}
                onFocus={() => setEditing(true)}
                onBlur={() => {
                    setEditing(false);
                    if (!value.trim() && value) onChange('');
                }}
                onChange={(event) => {
                    setEditing(true);
                    onChange(normalizeProviderKeyDraftInput(
                        event.target.value,
                        fieldState.showingSavedMask,
                    ));
                }}
                fullWidth
                slotProps={{
                    htmlInput: {
                        autoComplete: 'new-password',
                        'aria-label': `${label} API key`,
                    },
                    input: {
                        readOnly: fieldState.showingSavedMask,
                        endAdornment: (
                            <InputAdornment position="end" sx={{gap: 0.1, mr: -0.5}}>
                                {fieldState.hasDraft ? (
                                    <Tooltip title={saved ? 'Replace key' : 'Save key'} arrow>
                                        <IconButton
                                            size="small"
                                            color="primary"
                                            aria-label={saved ? `Replace ${label} API key` : `Save ${label} API key`}
                                            onClick={() => void onSave(value)}
                                        >
                                            <PublishedWithChangesOutlinedIcon fontSize="small"/>
                                        </IconButton>
                                    </Tooltip>
                                ) : null}
                                {saved ? (
                                    <Tooltip title={testing ? 'Testing model…' : 'Test selected model'} arrow>
                                        <span>
                                            <IconButton
                                                size="small"
                                                aria-label={`Test ${label} model`}
                                                disabled={testing}
                                                onClick={() => void onTest(provider)}
                                            >
                                                {testing
                                                    ? <CircularProgress size={17} thickness={5}/>
                                                    : <ScienceOutlinedIcon fontSize="small"/>}
                                            </IconButton>
                                        </span>
                                    </Tooltip>
                                ) : null}
                                {saved ? (
                                    <Tooltip title="Remove saved key" arrow>
                                        <IconButton
                                            size="small"
                                            color="warning"
                                            aria-label={`Remove ${label} API key`}
                                            onClick={() => void onSave('')}
                                        >
                                            <DeleteOutlineIcon fontSize="small"/>
                                        </IconButton>
                                    </Tooltip>
                                ) : null}
                            </InputAdornment>
                        ),
                    },
                }}
            />
            {testMessage ? <Typography variant="caption" color="text.secondary">{testMessage}</Typography> : null}
        </div>
    );
}

type Props = {
    openaiKey: string;
    googleKey: string;
    hasOpenAiKey: boolean;
    hasGoogleKey: boolean;
    testing: Provider | null;
    messages: Record<Provider, string>;
    onOpenAiChange: (value: string) => void;
    onGoogleChange: (value: string) => void;
    onOpenAiSave: (value: string) => Promise<void>;
    onGoogleSave: (value: string) => Promise<void>;
    onTest: (provider: Provider) => Promise<void>;
};

export function ProviderCredentialsSection(props: Props) {
    return (
        <section className="settings-card card">
            <h3 className="settings-card__title">API Keys</h3>
            <div className="ai-settings__grid">
                <ProviderKeyField
                    provider="openai"
                    label="OpenAI"
                    value={props.openaiKey}
                    saved={props.hasOpenAiKey}
                    testing={props.testing === 'openai'}
                    testMessage={props.messages.openai}
                    onChange={props.onOpenAiChange}
                    onSave={props.onOpenAiSave}
                    onTest={props.onTest}
                />
                <ProviderKeyField
                    provider="google"
                    label="Google AI"
                    value={props.googleKey}
                    saved={props.hasGoogleKey}
                    testing={props.testing === 'google'}
                    testMessage={props.messages.google}
                    onChange={props.onGoogleChange}
                    onSave={props.onGoogleSave}
                    onTest={props.onTest}
                />
            </div>
        </section>
    );
}
