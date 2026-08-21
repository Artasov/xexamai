// noinspection JSUnusedGlobalSymbols
// noinspection XmlDeprecatedElement

import {TextField} from '@mui/material';

type Props = {
    apiSttTimeout: number;
    apiLlmTimeout: number;
    onChangeApiStt: (value: number) => void;
    onChangeApiLlm: (value: number) => void;
};

export function TimeoutSettingsSection({
                                           apiSttTimeout,
                                           apiLlmTimeout,
                                           onChangeApiStt,
                                           onChangeApiLlm,
                                       }: Props) {
    return (
        <section className="settings-card card">
            <h3 className="settings-card__title">API timeouts (ms)</h3>
            <div className="ai-settings__grid ai-settings__grid--timeouts">
                <div className="settings-field">
                    <TextField
                        label="Transcription"
                        type="number"
                        value={apiSttTimeout}
                        size="small"
                        onChange={(event) => onChangeApiStt(Number(event.target.value))}
                        inputProps={{min: 1000, max: 600000, step: 500}}
                    />
                </div>
                <div className="settings-field">
                    <TextField
                        label="LLM"
                        type="number"
                        value={apiLlmTimeout}
                        size="small"
                        onChange={(event) => onChangeApiLlm(Number(event.target.value))}
                        inputProps={{min: 1000, max: 600000, step: 500}}
                    />
                </div>
            </div>
        </section>
    );
}
