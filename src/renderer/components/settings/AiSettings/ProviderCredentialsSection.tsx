import {Box, Button, TextField, Typography} from '@mui/material';

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
    return (
        <div className="settings-field">
            <TextField
                label={label}
                type="password"
                size="small"
                value={value}
                placeholder={saved ? 'Saved securely — enter a replacement' : `Enter your ${label} API key`}
                onChange={(event) => onChange(event.target.value)}
                fullWidth
            />
            <Box sx={{display: 'flex', gap: .75, mt: .75, flexWrap: 'wrap'}}>
                <Button size="small" variant="contained" disabled={!value.trim()} onClick={() => void onSave(value)}>
                    {saved ? 'Replace key' : 'Save key'}
                </Button>
                <Button size="small" variant="outlined" disabled={!saved || testing} onClick={() => void onTest(provider)}>
                    {testing ? 'Testing…' : 'Test model'}
                </Button>
                <Button size="small" color="warning" disabled={!saved} onClick={() => void onSave('')}>
                    Remove
                </Button>
            </Box>
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
