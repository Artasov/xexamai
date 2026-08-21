use tauri::Wry;
use tauri_specta::{collect_commands, Builder, ErrorHandlingMode};

#[cfg(test)]
const BINDINGS_FILE: &str = "NativeBindings.ts";
#[cfg(test)]
const COMMAND_MAP_FILE: &str = "NativeCommandMap.ts";

/// The single source of truth for both the runtime Tauri handler and generated
/// TypeScript bindings. `collect_commands!` reads the compiler-checked function
/// signatures produced by `#[specta::specta]`.
pub(crate) fn builder() -> Builder<Wry> {
    Builder::new()
        .commands(collect_commands![
            crate::config_get,
            crate::config_update,
            crate::config_reset,
            crate::config_path,
            crate::open_config_folder,
            crate::app_log_path,
            crate::open_app_logs_folder,
            crate::log_frontend,
            crate::diagnostics_snapshot,
            crate::app_shutdown_complete,
            crate::activity_register_session,
            crate::activity_begin,
            crate::activity_end,
            crate::open_external_url,
            crate::auth_consume_pending,
            crate::auth_renderer_not_ready,
            crate::auth_cancel_pending,
            crate::auth_get_methods,
            crate::auth_start_oauth,
            crate::auth_session::auth_session_bootstrap,
            crate::auth_session::auth_session_import_legacy,
            crate::auth_session::auth_session_login,
            crate::auth_session::auth_session_refresh,
            crate::auth_session::auth_session_logout,
            crate::google_live::google_live_capability,
            crate::google_live::google_live_create_token,
            crate::provider_proxy::provider_proxy_request,
            crate::provider_proxy::provider_proxy_stream,
            crate::provider_proxy::provider_proxy_cancel,
            crate::provider_proxy::provider_test_model,
            crate::local_speech_get_status,
            crate::local_speech_check_health,
            crate::local_speech_install,
            crate::local_speech_start,
            crate::local_speech_restart,
            crate::local_speech_reinstall,
            crate::local_speech_stop,
            crate::local_speech_check_model_downloaded,
            crate::ollama_check_installed,
            crate::ollama_list_models,
            crate::ollama_pull_model,
            crate::ollama_warmup_model,
            crate::ollama::ollama_stream_chat,
            crate::ollama::ollama_cancel_chat,
            crate::audio_list_devices,
            crate::audio_start_capture,
            crate::audio_stop_capture,
            crate::update::check_app_update,
            crate::update::download_app_update,
            crate::update::install_app_update,
            crate::update::discard_app_update,
            crate::transcription::transcribe_audio,
            crate::transcription::cancel_transcription,
        ])
        // Tauri rejects command errors; preserve that established renderer API.
        .error_handling(ErrorHandlingMode::Throw)
        // IPC serializes integers as JSON numbers. All exposed counters, byte
        // lengths and timeouts are bounded far below JavaScript's safe limit.
        .dangerously_cast_bigints_to_number()
        .semantic_types(specta_typescript::semantic::Configuration::default())
        .typ::<crate::update::UpdateProgressPayload>()
        .typ::<crate::update::UpdateStartedPayload>()
        .typ::<crate::update::UpdateErrorPayload>()
}

#[cfg(test)]
#[derive(Debug, Clone, Copy)]
struct CommandMapExporter;

#[cfg(test)]
impl tauri_specta::LanguageExt for CommandMapExporter {
    type Error = std::io::Error;

    fn export(
        self,
        config: &tauri_specta::BuilderConfiguration,
        path: &std::path::Path,
    ) -> Result<(), Self::Error> {
        std::fs::write(path, render_command_map(config))
    }
}

#[cfg(test)]
fn render_command_map(config: &tauri_specta::BuilderConfiguration) -> String {
    use specta::datatype::DataType;

    let mut output = String::from(
        "// This file has been generated from compiler-checked Rust command signatures. Do not edit it manually.\n\
import type {commands} from './NativeBindings';\n\n\
type NativeBindings = typeof commands;\n\n\
export type NativeCommandMap = {\n",
    );

    for command in &config.commands {
        let rust_name = command.name();
        let binding_name = lower_camel_case(rust_name);
        output.push_str(&format!("    {rust_name:?}: {{\n        args: "));
        if command.args().is_empty() {
            output.push_str("undefined");
        } else {
            output.push_str("{\n");
            for (index, (argument_name, datatype)) in command.args().iter().enumerate() {
                let argument_name = lower_camel_case(argument_name);
                let optional = if matches!(datatype, DataType::Nullable(_)) {
                    "?"
                } else {
                    ""
                };
                output.push_str(&format!(
                    "            {argument_name}{optional}: Parameters<NativeBindings[{binding_name:?}]>[{index}];\n"
                ));
            }
            output.push_str("        }");
        }
        output.push_str(&format!(
            ";\n        result: Awaited<ReturnType<NativeBindings[{binding_name:?}]>>;\n    }};\n"
        ));
    }
    output.push_str("};\n\nexport type NativeCommand = keyof NativeCommandMap;\n");
    output
}

#[cfg(test)]
fn lower_camel_case(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut uppercase_next = false;
    for character in value.chars() {
        if character == '_' {
            uppercase_next = true;
        } else if uppercase_next {
            output.extend(character.to_uppercase());
            uppercase_next = false;
        } else {
            output.push(character);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::*;
    use specta_typescript::Typescript;

    fn generated_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/shared/generated")
    }

    fn export_to(directory: &Path) {
        fs::create_dir_all(directory).expect("create bindings directory");
        let builder = builder();
        let bindings_path = directory.join(BINDINGS_FILE);
        builder
            .export(Typescript::default(), &bindings_path)
            .expect("export Tauri Specta bindings");
        normalize_trailing_newline(&bindings_path);
        builder
            .export(CommandMapExporter, directory.join(COMMAND_MAP_FILE))
            .expect("export native command compatibility map");
    }

    fn normalize_trailing_newline(path: &Path) {
        let content = fs::read_to_string(path).expect("read generated binding");
        let normalized = format!("{}\n", content.trim_end_matches(['\r', '\n']));
        fs::write(path, normalized).expect("normalize generated binding newline");
    }

    #[test]
    #[ignore = "run explicitly via `npm run bindings:generate`"]
    fn export_bindings() {
        export_to(&generated_dir());
    }

    #[test]
    fn generated_bindings_are_current() {
        let temporary = std::env::temp_dir().join(format!(
            "xexamai-ipc-bindings-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        export_to(&temporary);

        let expected_files = [BINDINGS_FILE, COMMAND_MAP_FILE]
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>();
        let actual_files = fs::read_dir(generated_dir())
            .expect("run `npm run bindings:generate` to create generated bindings")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            actual_files, expected_files,
            "generated binding set changed; run `npm run bindings:generate`"
        );

        for file in expected_files {
            let actual = fs::read(generated_dir().join(&file))
                .unwrap_or_else(|_| panic!("missing {file}; run `npm run bindings:generate`"));
            let expected = fs::read(temporary.join(&file)).expect("read temporary binding");
            assert_eq!(
                actual, expected,
                "{file} is stale; run `npm run bindings:generate`"
            );
        }

        let _ = fs::remove_dir_all(temporary);
    }

    #[test]
    fn camel_case_matches_tauri_specta_command_names() {
        assert_eq!(lower_camel_case("config_get"), "configGet");
        assert_eq!(lower_camel_case("oauth"), "oauth");
    }
}
