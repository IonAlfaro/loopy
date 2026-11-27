use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;

#[derive(Deserialize)]
pub(super) struct DeliveryPlan {
    kind: String,
    slug: String,
    summary: String,
}

#[derive(Deserialize, Serialize)]
pub(super) struct DeliveryBranch {
    pub workspace: PathBuf,
    pub branch: String,
    base: String,
    message: String,
    remote: String,
}

pub(super) async fn prepare(
    workspace: &Path,
    plan: DeliveryPlan,
    remote: &str,
) -> Result<DeliveryBranch, String> {
    if !matches!(
        plan.kind.as_str(),
        "fix" | "feat" | "refactor" | "docs" | "test" | "chore" | "perf"
    ) || plan.slug.is_empty()
        || plan.slug.len() > 64
        || !plan.slug.split('-').all(|word| {
            !word.is_empty()
                && word
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
        || plan.summary.trim().is_empty()
        || plan.summary.chars().any(char::is_control)
    {
        return Err("El diagnóstico no produjo un tipo, nombre de rama y resumen válidos.".into());
    }
    git(workspace, &["remote", "get-url", "--push", "--", remote]).await?;
    let base = git(workspace, &["rev-parse", "--verify", "HEAD"]).await?;
    let branch = format!("{}/{}", plan.kind, plan.slug);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("loors-delivery-{}-{nonce}", std::process::id()));
    let path = directory
        .to_str()
        .ok_or("La ruta del workspace temporal no es UTF-8.")?;
    git(workspace, &["worktree", "add", "-b", &branch, path, &base]).await?;
    Ok(DeliveryBranch {
        workspace: directory,
        branch,
        base,
        message: format!("{}: {}", plan.kind, plan.summary.trim()),
        remote: remote.into(),
    })
}

pub(super) async fn publish(delivery: &DeliveryBranch) -> Result<String, String> {
    let workspace = &delivery.workspace;
    let branch = git(workspace, &["symbolic-ref", "--short", "HEAD"]).await?;
    let head = git(workspace, &["rev-parse", "--verify", "HEAD"]).await?;
    if branch != delivery.branch || head != delivery.base {
        return Err("La rama de entrega o su commit base cambiaron durante la ejecución.".into());
    }

    git(workspace, &["add", "--all"]).await?;
    let tree = git(workspace, &["write-tree"]).await?;
    if tree == git(workspace, &["rev-parse", "HEAD^{tree}"]).await? {
        return Err("La rama no contiene cambios para publicar.".into());
    }
    git(workspace, &["commit", "-m", &delivery.message]).await?;
    let commit = git(workspace, &["rev-parse", "--verify", "HEAD"]).await?;
    if tree != git(workspace, &["rev-parse", "HEAD^{tree}"]).await?
        || delivery.base != git(workspace, &["rev-parse", "HEAD^"]).await?
    {
        return Err(format!(
            "El commit {commit} difiere de los cambios preparados. Revisa el worktree."
        ));
    }

    let refspec = format!("{commit}:refs/heads/{}", delivery.branch);
    git(workspace, &["push", "--", &delivery.remote, &refspec])
        .await
        .map_err(|err| format!("Commit local {commit} creado. {err}"))?;
    Ok(format!(
        "Rama {} publicada en {} con el commit {commit}. Worktree: {}",
        delivery.branch,
        delivery.remote,
        workspace.display()
    ))
}

async fn git(workspace: &Path, args: &[&str]) -> Result<String, String> {
    let action = args[0];
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workspace)
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000);
    let output = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .map_err(|_| format!("git {action} agotó su tiempo de espera."))?
        .map_err(|err| format!("No se pudo ejecutar git {action}: {err}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        Err(format!(
            "git {action} falló ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publishes_isolated_fix_and_preserves_original_changes() {
        let root = std::env::temp_dir().join(format!("loors-delivery-test-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let repo = root.join("source");
        let remote = root.join("remote.git");
        git(&root, &["init", repo.to_str().unwrap()]).await.unwrap();
        git(&root, &["init", "--bare", remote.to_str().unwrap()])
            .await
            .unwrap();
        git(&repo, &["config", "user.name", "Loors Test"])
            .await
            .unwrap();
        git(&repo, &["config", "user.email", "loors@example.invalid"])
            .await
            .unwrap();
        git(&repo, &["config", "commit.gpgsign", "false"])
            .await
            .unwrap();
        git(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        )
        .await
        .unwrap();
        std::fs::write(repo.join("tracked.txt"), "base").unwrap();
        git(&repo, &["add", "tracked.txt"]).await.unwrap();
        git(&repo, &["commit", "-m", "Initial commit"])
            .await
            .unwrap();
        std::fs::write(repo.join("tracked.txt"), "user changes").unwrap();

        let delivery = prepare(
            &repo,
            DeliveryPlan {
                kind: "fix".into(),
                slug: "tracked-text".into(),
                summary: "correct tracked text".into(),
            },
            "origin",
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(delivery.workspace.join("tracked.txt")).unwrap(),
            "base"
        );
        std::fs::write(delivery.workspace.join("tracked.txt"), "fixed").unwrap();
        let report = publish(&delivery).await.unwrap();
        assert!(report.contains("fix/tracked-text"));
        assert_eq!(
            git(&remote, &["show", "fix/tracked-text:tracked.txt"])
                .await
                .unwrap(),
            "fixed"
        );
        assert_eq!(
            git(&remote, &["log", "-1", "--format=%s", "fix/tracked-text"])
                .await
                .unwrap(),
            "fix: correct tracked text"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("tracked.txt")).unwrap(),
            "user changes"
        );

        git(
            &repo,
            &["worktree", "remove", delivery.workspace.to_str().unwrap()],
        )
        .await
        .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
