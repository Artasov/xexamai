// noinspection JSUnusedGlobalSymbols
// noinspection XmlDeprecatedElement

import {Button, Stack, TextField, Typography} from '@mui/material';
import {checkFeatureAccess, showFeatureAccessModal} from '../../../ui/featureAccessModal';

export const PROMPT_PRESETS = [
    {
        id: 'concise-interview',
        label: 'Concise interview',
        transcription: 'Transcribe verbatim in the original spoken language. Preserve technical terms and do not answer the question.',
        llm: 'Act as a concise interview copilot. Start immediately with a natural answer I can say aloud. Give the conclusion first, then only the minimum reasoning needed to defend it. Keep the whole response to 2–5 short sentences unless I explicitly ask for detail.',
    },
    {
        id: 'coding-interview',
        label: 'Coding interview',
        transcription: 'Transcribe verbatim. Preserve code identifiers, numbers, library names, and programming terminology.',
        llm: 'Solve coding interview questions accurately. Explain the approach, edge cases, complexity, and provide production-quality code when requested.',
    },
    {
        id: 'behavioral-star',
        label: 'Behavioral · STAR',
        transcription: 'Transcribe the complete question verbatim in its original language.',
        llm: 'Draft a natural first-person STAR answer: Situation, Task, Action, Result. Keep claims concrete and avoid inventing facts not present in the context.',
    },
] as const;

type Props = {
    transcriptionPrompt: string;
    llmPrompt: string;
    onChangeTranscription: (value: string) => void;
    onChangeLlm: (value: string) => void;
};

export function PromptSettingsSection({
    transcriptionPrompt,
    llmPrompt,
    onChangeTranscription,
    onChangeLlm,
}: Props) {
    const applyPreset = (preset: typeof PROMPT_PRESETS[number]) => {
        if (!checkFeatureAccess('promt_presets')) {
            showFeatureAccessModal('promt_presets');
            return;
        }
        onChangeTranscription(preset.transcription);
        onChangeLlm(preset.llm);
    };

    return (
        <section className="settings-card card">
            <h3 className="settings-card__title">Prompts</h3>
            <Stack spacing={1.25} sx={{mb: 2}}>
                <Typography variant="body2" color="text.secondary">
                    Premium presets fill both prompts at once. You can review and edit them before saving.
                </Typography>
                <Stack direction="row" useFlexGap flexWrap="wrap" gap={1}>
                    {PROMPT_PRESETS.map((preset) => (
                        <Button
                            key={preset.id}
                            type="button"
                            size="small"
                            variant="outlined"
                            onClick={() => applyPreset(preset)}
                        >
                            {preset.label}
                        </Button>
                    ))}
                </Stack>
            </Stack>
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
