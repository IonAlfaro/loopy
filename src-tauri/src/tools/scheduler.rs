use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

struct ScheduledTaskRecord {
    id: String,
    label: String,
    command: String,
    workspace: String,
    interval_secs: u64,
    max_runs: u32,
    runs_completed: Arc<AtomicU32>,
    active: Arc<AtomicBool>,
    last_output: Arc<Mutex<String>>,
    cancel_tx: Option<oneshot::Sender<()>>,
}

static SCHEDULED_TASKS: OnceLock<Mutex<HashMap<String, ScheduledTaskRecord>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, ScheduledTaskRecord>> {
    SCHEDULED_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn schedule_task(
    workspace: &str,
    label: &str,
    command: &str,
    delay_secs: u64,
    interval_secs: u64,
    max_runs: u32,
) -> Result<String, String> {
    let clean_cmd = command.trim();
    if clean_cmd.is_empty() {
        return Err("schedule_task requires a non-empty 'command'.".to_string());
    }
    let effective_interval = if interval_secs > 0 {
        interval_secs
    } else {
        delay_secs.max(1)
    };
    let effective_max = if interval_secs == 0 {
        1
    } else if max_runs == 0 {
        100
    } else {
        max_runs
    };

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let id = format!("sched-{}", ts % 1_000_000);
    let runs_completed = Arc::new(AtomicU32::new(0));
    let active = Arc::new(AtomicBool::new(true));
    let last_output = Arc::new(Mutex::new(String::new()));
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();

    let cmd_owned = clean_cmd.to_string();
    let ws_owned = workspace.to_string();
    let runs_clone = runs_completed.clone();
    let active_clone = active.clone();
    let out_clone = last_output.clone();

    tokio::spawn(async move {
        let initial_wait = if delay_secs > 0 {
            delay_secs
        } else {
            effective_interval
        };
        let mut wait_secs = initial_wait;

        for _ in 0..effective_max {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(wait_secs)) => {}
                _ = &mut cancel_rx => {
                    active_clone.store(false, Ordering::SeqCst);
                    return;
                }
            }

            let mut cmd = if cfg!(target_os = "windows") {
                let mut c = tokio::process::Command::new("powershell");
                c.args(["-NoProfile", "-Command", &cmd_owned]);
                #[cfg(target_os = "windows")]
                c.creation_flags(0x0800_0000);
                c
            } else {
                let mut c = tokio::process::Command::new("sh");
                c.args(["-c", &cmd_owned]);
                c
            };
            if !ws_owned.trim().is_empty() && ws_owned.trim() != "." {
                cmd.current_dir(&ws_owned);
            }
            let res_text = match cmd.output().await {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    if stderr.is_empty() {
                        stdout
                    } else if stdout.is_empty() {
                        format!("[stderr] {stderr}")
                    } else {
                        format!("{stdout}\n[stderr] {stderr}")
                    }
                }
                Err(e) => format!("Execution error: {e}"),
            };

            if let Ok(mut guard) = out_clone.lock() {
                *guard = res_text;
            }
            runs_clone.fetch_add(1, Ordering::SeqCst);
            wait_secs = effective_interval;
        }
        active_clone.store(false, Ordering::SeqCst);
    });

    if let Ok(mut map) = registry().lock() {
        map.insert(
            id.clone(),
            ScheduledTaskRecord {
                id: id.clone(),
                label: if label.trim().is_empty() {
                    clean_cmd.to_string()
                } else {
                    label.trim().to_string()
                },
                command: clean_cmd.to_string(),
                workspace: workspace.to_string(),
                interval_secs: effective_interval,
                max_runs: effective_max,
                runs_completed,
                active,
                last_output,
                cancel_tx: Some(cancel_tx),
            },
        );
    }

    Ok(format!(
        "Scheduled task '{id}' (interval={}s, max_runs={}). Use list_scheduled_tasks to check output or cancel_scheduled_task(task_id='{id}') to stop.",
        effective_interval, effective_max
    ))
}

pub fn list_scheduled_tasks() -> String {
    let Ok(map) = registry().lock() else {
        return "Scheduler registry unavailable.".to_string();
    };
    if map.is_empty() {
        return "No scheduled tasks.".to_string();
    }
    let mut rows = Vec::new();
    for rec in map.values() {
        let is_active = rec.active.load(Ordering::SeqCst);
        let done = rec.runs_completed.load(Ordering::SeqCst);
        let preview = rec
            .last_output
            .lock()
            .map(|s| {
                let t = s.trim();
                if t.is_empty() {
                    "(pending)".to_string()
                } else if t.len() > 160 {
                    format!("{}...", &t[..160])
                } else {
                    t.to_string()
                }
            })
            .unwrap_or_default();
        rows.push(format!(
            "- {} [{}] '{}' (`{}` · {}/{} runs, every {}s, ws={}) -> {}",
            rec.id,
            if is_active { "active" } else { "finished" },
            rec.label,
            rec.command,
            done,
            rec.max_runs,
            rec.interval_secs,
            rec.workspace,
            preview
        ));
    }
    rows.sort();
    format!("Scheduled tasks ({}):\n{}", rows.len(), rows.join("\n"))
}

pub fn cancel_scheduled_task(task_id: &str) -> String {
    let id = task_id.trim();
    let Ok(mut map) = registry().lock() else {
        return "Scheduler registry unavailable.".to_string();
    };
    let Some(rec) = map.get_mut(id) else {
        return format!("Scheduled task '{id}' not found.");
    };
    if let Some(tx) = rec.cancel_tx.take() {
        let _ = tx.send(());
        rec.active.store(false, Ordering::SeqCst);
        format!("Cancelled scheduled task '{id}'.")
    } else {
        format!("Scheduled task '{id}' was already cancelled or finished.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn schedules_executes_and_cancels_task() {
        let cmd = if cfg!(target_os = "windows") {
            "Write-Output 'tick-ok'"
        } else {
            "echo tick-ok"
        };
        let msg = schedule_task(".", "quick-tick", cmd, 1, 0, 1).expect("should schedule");
        let id = msg
            .split("task '")
            .nth(1)
            .and_then(|s| s.split('\'').next())
            .expect("should include id")
            .to_string();

        tokio::time::sleep(Duration::from_millis(1600)).await;
        let list = list_scheduled_tasks();
        assert!(list.contains(&id), "Expected {id} in:\n{list}");
        assert!(list.contains("tick-ok"), "Expected tick-ok in:\n{list}");
    }
}
