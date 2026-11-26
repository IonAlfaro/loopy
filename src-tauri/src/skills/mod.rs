use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedSkill {
    pub name: String,
    pub description: String,
    pub body: String,
    pub path: String,
}

pub fn global_skills_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("loors")
        .join("skills")
}

pub fn discover_skills(workspace: &str) -> Vec<SkillSummary> {
    let mut roots: Vec<(PathBuf, &str)> = vec![(global_skills_dir(), "global")];

    let ws = if workspace.trim().is_empty() || workspace == "." {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(workspace)
    };

    roots.push((ws.join(".loors").join("skills"), "workspace"));
    roots.push((ws.join(".agents").join("skills"), "workspace"));
    roots.push((ws.join(".claude").join("skills"), "workspace"));

    let mut found = Vec::new();
    for (root, source) in roots {
        if !root.exists() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let skill_file = if path.is_dir() {
                path.join("SKILL.md")
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case("SKILL.md"))
                .unwrap_or(false)
            {
                path
            } else {
                continue;
            };

            if skill_file.is_file() {
                if let Ok(loaded) = load_skill_file(&skill_file) {
                    found.push(SkillSummary {
                        name: loaded.name,
                        description: loaded.description,
                        path: loaded.path,
                        source: source.to_string(),
                    });
                }
            }
        }
    }

    found.sort_by(|a, b| a.name.cmp(&b.name));
    found.dedup_by(|a, b| a.path == b.path);
    found
}

pub fn load_skill_file(path: &Path) -> Result<LoadedSkill, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("No se pudo leer SKILL.md '{}': {e}", path.display()))?;
    let fallback_name = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("skill")
        .to_string();
    Ok(parse_skill_md(
        &raw,
        &fallback_name,
        &path.to_string_lossy(),
    ))
}

pub fn parse_skill_md(raw: &str, fallback_name: &str, path: &str) -> LoadedSkill {
    let normalized = raw.replace("\r\n", "\n");
    let mut name = fallback_name.to_string();
    let mut description = String::new();
    let mut body = normalized.clone();

    if let Some(rest) = normalized.strip_prefix("---\n") {
        if let Some(end_idx) = rest.find("\n---") {
            let frontmatter = &rest[..end_idx];
            body = rest[end_idx + 4..].trim_start().to_string();

            for line in frontmatter.lines() {
                let trimmed = line.trim();
                if let Some(val) = trimmed.strip_prefix("name:") {
                    let v = val.trim().trim_matches('"').trim_matches('\'');
                    if !v.is_empty() {
                        name = v.to_string();
                    }
                } else if let Some(val) = trimmed.strip_prefix("description:") {
                    let v = val.trim().trim_matches('"').trim_matches('\'');
                    if !v.is_empty() {
                        description = v.to_string();
                    }
                }
            }
        }
    }

    LoadedSkill {
        name,
        description,
        body,
        path: path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_skill_md_frontmatter_and_body() {
        let raw = "---\nname: android-tdd\ndescription: \"Reglas de testing Android\"\n---\n\n# Pasos\n1. Ejecuta gradlew test\n";
        let skill = parse_skill_md(raw, "fallback", "/tmp/SKILL.md");
        assert_eq!(skill.name, "android-tdd");
        assert_eq!(skill.description, "Reglas de testing Android");
        assert!(skill.body.contains("gradlew test"));
    }
}
