use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

const MAX_LOG_LINES: usize = 200;

struct BgTaskRecord {
    id: String,
    command: String,
    workspace: String,
    started_at: Instant,
    running: Arc<AtomicBool>,
    exit_code: Arc<Mutex<Option<i32>>>,
    logs: Arc<Mutex<VecDeque<String>>>,
    kill_tx: Option<oneshot::Sender<()>>,
}

static BG_TASKS: OnceLock<Mutex<HashMap<String, BgTaskRecord>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, BgTaskRecord>> {
    BG_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn push_log(logs: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut buf) = logs.lock() {
        if buf.len() >= MAX_LOG_LINES {
            buf.pop_front();
        }
        buf.push_back(line);
    }
}

pub fn start_bg_task(workspace: &str, command_str: &str) -> Result<String, String> {
    let trimmed = command_str.trim();
    if trimmed.is_empty() {
        return Err("Command cannot be empty.".to_string());
    }

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-Command", trimmed]);
        #[cfg(target_os = "windows")]
        c.creation_flags(0x0800_0000);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", trimmed]);
        c
    };

    if !workspace.trim().is_empty() && workspace.trim() != "." {
        cmd.current_dir(workspace);
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start background task: {e}"))?;

    let pid = child.id().unwrap_or(0);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let task_id = format!("bg-{}-{}", ts % 100_000, pid);

    let running = Arc::new(AtomicBool::new(true));
    let exit_code = Arc::new(Mutex::new(None));
    let logs = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES)));
    let (kill_tx, mut kill_rx) = oneshot::channel::<()>();

    if let Some(stdout) = child.stdout.take() {
        let logs_out = logs.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                push_log(&logs_out, line);
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let logs_err = logs.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                push_log(&logs_err, format!("[stderr] {line}"));
            }
        });
    }

    let run_flag = running.clone();
    let code_slot = exit_code.clone();
    tokio::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                if let Ok(st) = status {
                    if let Ok(mut guard) = code_slot.lock() {
                        *guard = st.code();
                    }
                }
            }
            _ = &mut kill_rx => {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
        run_flag.store(false, Ordering::SeqCst);
    });

    if let Ok(mut map) = registry().lock() {
        map.insert(
            task_id.clone(),
            BgTaskRecord {
                id: task_id.clone(),
                command: trimmed.to_string(),
                workspace: workspace.to_string(),
                started_at: Instant::now(),
                running,
                exit_code,
                logs,
                kill_tx: Some(kill_tx),
            },
        );
    }

    Ok(format!(
        "Background task started: id='{task_id}' (pid={pid}). Use bg_task_status(task_id='{task_id}') to inspect output or kill_bg_task(task_id='{task_id}') to stop it."
    ))
}

pub fn get_bg_task_status(task_id: Option<&str>, tail_lines: usize) -> String {
    let tail = tail_lines.clamp(5, MAX_LOG_LINES);
    let Ok(map) = registry().lock() else {
        return "Background task registry unavailable.".to_string();
    };

    if let Some(id) = task_id.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let Some(rec) = map.get(id) else {
            return format!("Background task '{id}' not found.");
        };
        let is_running = rec.running.load(Ordering::SeqCst);
        let code = rec.exit_code.lock().ok().and_then(|g| *g);
        let elapsed = rec.started_at.elapsed().as_secs();
        let state = if is_running {
            format!("running ({elapsed}s)")
        } else {
            format!("exited (code={:?}, {elapsed}s)", code)
        };
        let lines: Vec<String> = rec
            .logs
            .lock()
            .map(|buf| {
                let skip = buf.len().saturating_sub(tail);
                buf.iter().skip(skip).cloned().collect()
            })
            .unwrap_or_default();
        let output = if lines.is_empty() {
            "(no output yet)".to_string()
        } else {
            lines.join("\n")
        };
        return format!(
            "Task: {}\nCommand: {}\nWorkspace: {}\nState: {}\n--- Last {} lines ---\n{}",
            rec.id, rec.command, rec.workspace, state, lines.len(), output
        );
    }

    if map.is_empty() {
        return "No background tasks have been started.".to_string();
    }

    let mut rows = Vec::new();
    for rec in map.values() {
        let is_running = rec.running.load(Ordering::SeqCst);
        let code = rec.exit_code.lock().ok().and_then(|g| *g);
        let elapsed = rec.started_at.elapsed().as_secs();
        let st = if is_running {
            format!("running ({elapsed}s)")
        } else {
            format!("exited code={:?}", code)
        };
        rows.push(format!("- {} [{}] `{}`", rec.id, st, rec.command));
    }
    rows.sort();
    format!("Background tasks ({}):\n{}", rows.len(), rows.join("\n"))
}

pub fn kill_bg_task(task_id: &str) -> String {
    let id = task_id.trim();
    let Ok(mut map) = registry().lock() else {
        return "Background task registry unavailable.".to_string();
    };
    let Some(rec) = map.get_mut(id) else {
        return format!("Background task '{id}' not found.");
    };
    if let Some(tx) = rec.kill_tx.take() {
        let _ = tx.send(());
        rec.running.store(false, Ordering::SeqCst);
        format!("Stopped background task '{id}'.")
    } else {
        format!("Background task '{id}' was already stopped.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn starts_reads_and_kills_background_task() {
        let cmd = if cfg!(target_os = "windows") {
            "Write-Output 'bg-hello'; Start-Sleep -Seconds 10"
        } else {
            "echo bg-hello; exec sleep 10"
        };
        let msg = start_bg_task(".", cmd).expect("should spawn bg task");
        let id = msg
            .split("id='")
            .nth(1)
            .and_then(|s| s.split('\'').next())
            .expect("should return task id")
            .to_string();

        tokio::time::sleep(Duration::from_millis(600)).await;
        let status = get_bg_task_status(Some(&id), 20);
        assert!(status.contains("bg-hello"), "Expected bg-hello in:\n{status}");
        assert!(status.contains("running"), "Expected running state in:\n{status}");

        let killed = kill_bg_task(&id);
        assert!(killed.contains("Stopped"));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let after = get_bg_task_status(Some(&id), 20);
        assert!(after.contains("exited"), "Expected exited after kill:\n{after}");
    }
}
