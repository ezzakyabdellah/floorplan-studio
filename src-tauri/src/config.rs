use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

pub const REQUIRED_KEYS: &[&str] = &["GEMINI_API_KEY"];

const ENV_TEMPLATE: &str = "\
# FloorPlan Studio local configuration.
# Create a free Google AI Studio key at https://aistudio.google.com/apikey
# Fill GEMINI_API_KEY below, save this file, then use Reload in the app banner.
GEMINI_API_KEY=
GEMINI_MODEL=gemini-4-hydrogen
GEMINI_FAST_MODEL=gemini-3.5-flash-lite
";

/// Values returned to the frontend. The API key is included because the React
/// client calls Gemini directly; it is never compiled into the installer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEnv {
    pub path: String,
    pub exists: bool,
    pub values: BTreeMap<String, String>,
    pub missing_keys: Vec<String>,
}

fn env_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(".env"))
        .map_err(|error| format!("Could not resolve the app config directory: {error}"))
}

/// Create the user-editable file on first run. Existing files are never
/// overwritten, so a user's key survives app updates.
pub fn ensure_env_file(app: &AppHandle) -> Result<PathBuf, String> {
    let path = env_file_path(app)?;
    if path.exists() {
        return Ok(path);
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Could not create the config directory {}: {error}",
                parent.display()
            )
        })?;
    }

    fs::write(&path, ENV_TEMPLATE).map_err(|error| {
        format!(
            "Could not create the environment file {}: {error}",
            path.display()
        )
    })?;
    set_private_permissions(&path);
    Ok(path)
}

pub fn read_app_env(app: &AppHandle) -> Result<AppEnv, String> {
    let path = ensure_env_file(app)?;
    let contents = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Could not read the environment file {}: {error}",
            path.display()
        )
    })?;

    let mut values = parse_env(&contents);
    apply_process_env_overrides(&mut values);
    let missing_keys = missing_keys(&values);

    Ok(AppEnv {
        path: path.to_string_lossy().into_owned(),
        exists: true,
        values,
        missing_keys,
    })
}

/// Real process environment variables take precedence over the file. This is
/// useful for development and CI without modifying the user's config file.
fn apply_process_env_overrides(values: &mut BTreeMap<String, String>) {
    let mut keys: Vec<String> = REQUIRED_KEYS.iter().map(|key| key.to_string()).collect();
    keys.extend(values.keys().cloned());

    for key in keys {
        if let Ok(value) = std::env::var(&key) {
            let value = value.trim();
            if !value.is_empty() {
                values.insert(key, value.to_string());
            }
        }
    }
}

fn missing_keys(values: &BTreeMap<String, String>) -> Vec<String> {
    REQUIRED_KEYS
        .iter()
        .filter(|key| {
            values
                .get(**key)
                .map(|value| is_placeholder(value))
                .unwrap_or(true)
        })
        .map(|key| (*key).to_string())
        .collect()
}

fn is_placeholder(value: &str) -> bool {
    let value = value.trim();
    value.is_empty() || value == "your-google-ai-studio-api-key"
}

fn parse_env(contents: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();

    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            continue;
        }
        values.insert(key.to_string(), unquote(value.trim()));
    }

    values
}

fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) {}

#[tauri::command]
pub fn get_app_env(app: AppHandle) -> Result<AppEnv, String> {
    read_app_env(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn parses_comments_blank_lines_exports_and_quotes() {
        let parsed = parse_env(
            r#"
# a comment
GEMINI_API_KEY=abc123
export GEMINI_MODEL="gemini-4-hydrogen"
GEMINI_FAST_MODEL='gemini-3.5-flash-lite'
INVALID KEY=ignored
NO_EQUALS
"#,
        );

        assert_eq!(
            parsed.get("GEMINI_API_KEY").map(String::as_str),
            Some("abc123")
        );
        assert_eq!(
            parsed.get("GEMINI_MODEL").map(String::as_str),
            Some("gemini-4-hydrogen")
        );
        assert_eq!(
            parsed.get("GEMINI_FAST_MODEL").map(String::as_str),
            Some("gemini-3.5-flash-lite")
        );
        assert!(!parsed.contains_key("INVALID KEY"));
        assert!(!parsed.contains_key("NO_EQUALS"));
    }

    #[test]
    fn treats_empty_and_placeholder_keys_as_missing() {
        assert_eq!(missing_keys(&values(&[])), vec!["GEMINI_API_KEY"]);
        assert_eq!(
            missing_keys(&values(&[("GEMINI_API_KEY", "   ")])),
            vec!["GEMINI_API_KEY"]
        );
        assert_eq!(
            missing_keys(&values(&[(
                "GEMINI_API_KEY",
                "your-google-ai-studio-api-key"
            )])),
            vec!["GEMINI_API_KEY"]
        );
    }

    #[test]
    fn accepts_a_real_key() {
        assert!(missing_keys(&values(&[("GEMINI_API_KEY", "AIza-real-key")])).is_empty());
    }

    #[test]
    fn keeps_values_containing_equals_signs() {
        let parsed = parse_env("GEMINI_API_KEY=abc=def\n");
        assert_eq!(
            parsed.get("GEMINI_API_KEY").map(String::as_str),
            Some("abc=def")
        );
    }
}
