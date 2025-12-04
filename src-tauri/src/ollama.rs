use anyhow::{anyhow, Result};
use std::io;
use std::process::Stdio;
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const LIST_JSON_FLAG: &str = "--json";

fn normalize_model_name(model: &str) -> String {
    model.trim().to_lowercase()
}

async fn run_ollama_command(args: &[&str]) -> Result<std::process::Output> {
    let mut cmd = Command::new("ollama");
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    
    let output = cmd.output().await;

    match output {
        Ok(result) => Ok(result),
        Err(error) => {
            if error.kind() == io::ErrorKind::NotFound {
                Err(anyhow!(
                    "Ollama CLI is not installed or not available in PATH."
                ))
            } else {
                Err(anyhow!(error))
            }
        }
    }
}

pub async fn check_installed() -> Result<bool> {
    let mut cmd = Command::new("ollama");
    cmd.arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    
    match cmd.status().await {
        Ok(status) => Ok(status.success()),
        Err(error) => {
            if error.kind() == io::ErrorKind::NotFound {
                Ok(false)
            } else {
                Err(anyhow!(error))
            }
        }
    }
}

pub async fn list_models() -> Result<Vec<String>> {
    let mut output = run_ollama_command(&["list", LIST_JSON_FLAG]).await?;

    if !output.status.success() {
        output = run_ollama_command(&["list"]).await?;
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "ollama list command failed: {}",
            stderr.trim().to_string()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_model_list(stdout.as_ref())
}

fn parse_model_list(output: &str) -> Result<Vec<String>> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(output) {
        let mut models = Vec::new();
        match value {
            serde_json::Value::Array(items) => {
                for item in items {
                    if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                        models.push(normalize_model_name(name));
                    }
                }
            }
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::Array(items)) = map.get("models") {
                    for item in items {
                        if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                            models.push(normalize_model_name(name));
                        }
                    }
                }
            }
            _ => {}
        }
        if !models.is_empty() {
            return Ok(models);
        }
    }

    let mut rows: Vec<&str> = output.lines().collect();
    if !rows.is_empty() && rows[0].to_ascii_lowercase().contains("name") {
        rows.remove(0);
    }

    let mut names = Vec::new();
    for line in rows {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("NAME ") {
            continue;
        }
        if let Some(name) = trimmed.split_whitespace().next() {
            names.push(normalize_model_name(name));
        }
    }

    Ok(names)
}

pub async fn pull_model(model: &str) -> Result<()> {
    let normalized = model.trim();
    if normalized.is_empty() {
        return Err(anyhow!("Model name is required."));
    }
    let output = run_ollama_command(&["pull", normalized]).await?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(anyhow!(
            "Failed to download model {}: {}",
            model,
            stderr.trim()
        ))
    }
}

pub async fn warmup_model(model: &str) -> Result<()> {
    let normalized = model.trim();
    if normalized.is_empty() {
        return Err(anyhow!("Model name is required."));
    }
    let prompt = "Write only the numbers 1, 2, 3.";
    let output = run_ollama_command(&["run", normalized, prompt]).await?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(anyhow!(
            "Failed to warm up model {}: {}",
            model,
            stderr.trim()
        ))
    }
}
