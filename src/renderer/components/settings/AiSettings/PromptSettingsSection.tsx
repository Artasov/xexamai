// noinspection JSUnusedGlobalSymbols
// noinspection XmlDeprecatedElement

import {Button, Stack, TextField, Typography} from '@mui/material';
import {checkFeatureAccess, showFeatureAccessModal} from '../../../ui/featureAccessModal';

export const PROMPT_PRESETS = [
    {
        id: 'concise-interview',
        label: 'Concise interview',
        transcription: 'Transcribe verbatim in the original spoken language. Preserve technical terms and do not answer the question.',
        screen: 'Extract the visible interview task and answer it directly. Prefer a concise, practical response.',
        llm: 'Act as a concise interview copilot. Give the direct answer first, then only the reasoning needed to defend it.',
    },
    {
        id: 'coding-interview',
        label: 'Coding interview',
        transcription: 'Transcribe verbatim. Preserve code identifiers, numbers, library names, and programming terminology.',
        screen: 'Analyze the coding task shown in the screenshot. State assumptions, propose a correct solution, and include complexity.',
        llm: 'Solve coding interview questions accurately. Explain the approach, edge cases, complexity, and provide production-quality code when requested.',
    },
    {
        id: 'behavioral-star',
        label: 'Behavioral · STAR',
        transcription: 'Transcribe the complete question verbatim in its original language.',
        screen: 'Extract the behavioral question and identify the competency it evaluates.',
        llm: 'Draft a natural first-person STAR answer: Situation, Task, Action, Result. Keep claims concrete and avoid inventing facts not present in the context.',
    },
] as const;

type Props = {
    transcriptionPrompt: string;
    llmPrompt: string;
    screenPrompt: string;
    onChangeTranscription: (value: string) => void;
    onChangeLlm: (value: string) => void;
    onChangeScreen: (value: string) => void;
};

export function PromptSettingsSection({
    transcriptionPrompt,
    llmPrompt,
    screenPrompt,
    onChangeTranscription,
    onChangeLlm,
    onChangeScreen,
}: Props) {
    const applyPreset = (preset: typeof PROMPT_PRESETS[number]) => {
        if (!checkFeatureAccess('promt_presets')) {
            showFeatureAccessModal('promt_presets');
            return;
        }
        onChangeTranscription(preset.transcription);
        onChangeScreen(preset.screen);
        onChangeLlm(preset.llm);
    };

    return (
        <section className="settings-card card">
            <h3 className="settings-card__title">Prompts</h3>
            <Stack spacing={1.25} sx={{mb: 2}}>
                <Typography variant="body2" color="text.secondary">
                    Premium presets fill all three prompts at once. You can review and edit them before saving.
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
                        label="Screen processing prompt"
                        value={screenPrompt}
                        onChange={(event) => onChangeScreen(event.target.value)}
                        fullWidth
                        multiline
                        minRows={3}
                        placeholder="Optional: global instruction for screenshot analysis"
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
