import {TextField} from '@mui/material';

type Props = {
    transcriptionPrompt: string;
    llmPrompt: string;
    onChangeTranscription: (value: string) => void;
    onChangeLlm: (value: string) => void;
};

export function PromptSettingsSection({transcriptionPrompt, llmPrompt, onChangeTranscription, onChangeLlm}: Props) {
    return (
        <section className="settings-card card">
            <h3 className="settings-card__title">Prompts</h3>
            <div className="ai-settings__grid">
                <div className="settings-field">
                    <TextField
                        label="Transcription prompt"
                        value={transcriptionPrompt}
                        onChange={(event) => onChangeTranscription(event.target.value)}
                        fullWidth
                        multiline
                        minRows={3}
                        placeholder="Optional: appended to transcription requests"
                    />
                </div>
                <div className="settings-field">
                    <TextField
                        label="LLM prompt"
                        value={llmPrompt}
                        onChange={(event) => onChangeLlm(event.target.value)}
                        fullWidth
                        multiline
                        minRows={3}
                        placeholder="Optional: system message for the LLM"
                    />
                </div>
            </div>
        </section>
    );
}
