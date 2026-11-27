use loors_lib::headless::{dispatch_rpc, generate_random_token, HeadlessState};
use serde_json::{json, Value};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use tokio::sync::oneshot;

pub const HELP: &str =
    "Usage: loors-cli agent [--worktree] [--workspace <dir>] [--model <path|cloud::...>] \
[--backend <auto|cuda|vulkan|metal|cpu>] [--context <tokens>] <prompt>

Uses LOORS_MODEL if --model is omitted. Tool approvals are requested on stdin.
--worktree starts from committed HEAD and keeps the worktree for desktop review.";

struct Options {
    workspace: PathBuf,
    worktree: bool,
    model: String,
    backend: String,
    context: Option<u32>,
    prompt: String,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self, String> {
        let cwd = std::env::current_dir().map_err(|err| err.to_string())?;
        let mut workspace = cwd.clone();
        let mut worktree = false;
        let mut model = std::env::var("LOORS_MODEL").unwrap_or_default();
        let mut backend = "auto".to_string();
        let mut context = None;
        let mut prompt = None;
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--worktree" => worktree = true,
                "--workspace" | "--model" | "--backend" | "--context" | "--" => {
                    let value = args
                        .next()
                        .ok_or_else(|| format!("Missing value for {arg}"))?;
                    match arg.as_str() {
                        "--workspace" => workspace = cwd.join(value),
                        "--model" => model = value.clone(),
                        "--backend" => {
                            if !matches!(
                                value.as_str(),
                                "auto" | "cuda" | "vulkan" | "metal" | "cpu"
                            ) {
                                return Err(format!("Unknown backend '{value}'"));
                            }
                            backend = value.clone();
                        }
                        "--context" => {
                            context = Some(
                                value
                                    .parse::<u32>()
                                    .ok()
                                    .filter(|n| *n > 0)
                                    .ok_or("--context requires a positive number of tokens")?,
                            );
                        }
                        _ if prompt.is_none() && args.len() == 0 => prompt = Some(value.clone()),
                        _ => return Err("Pass exactly one quoted prompt".into()),
                    }
                }
                option if option.starts_with('-') => {
                    return Err(format!("Unknown option '{option}'"))
                }
                _ if prompt.is_none() => prompt = Some(arg.clone()),
                _ => return Err("Pass exactly one quoted prompt".into()),
            }
        }
        let prompt = prompt
            .filter(|s| !s.trim().is_empty())
            .ok_or("A prompt is required")?;
        if model.trim().is_empty() {
            return Err("Select a model with --model or LOORS_MODEL. See loors-cli models.".into());
        }
        if !model.starts_with("cloud::") {
            let path = cwd.join(&model);
            if !path.is_file() {
                return Err(format!("Model file not found: {}", path.display()));
            }
            model = path
                .to_str()
                .ok_or("Model path must be valid UTF-8")?
                .to_string();
        }
        if !workspace.is_dir() {
            return Err(format!(
                "Workspace directory not found: {}",
                workspace.display()
            ));
        }
        Ok(Self {
            workspace,
            worktree,
            model,
            backend,
            context,
            prompt,
        })
    }
}

async fn create_worktree(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or("Worktree parent missing")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|err| err.to_string())?;
    let result = tokio::process::Command::new("git")
        .current_dir(source)
        .args(["worktree", "add", "--detach", "--"])
        .arg(destination)
        .arg("HEAD")
        .output()
        .await
        .map_err(|err| format!("Could not start git: {err}"))?;
    if !result.status.success() {
        return Err(format!(
            "Could not create worktree: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    Ok(())
}

async fn answer(prompt: String) -> String {
    let (tx, rx) = oneshot::channel();
    std::thread::spawn(move || {
        eprint!("{prompt}");
        let _ = io::stderr().flush();
        let mut line = String::new();
        let _ = io::stdin().read_line(&mut line);
        let _ = tx.send(line);
    });
    rx.await.unwrap_or_default()
}

fn print_token(event: &Value) {
    if event["is_thinking"] == false {
        if let Some(token) = event["token"].as_str() {
            print!("{token}");
            let _ = io::stdout().flush();
        }
    }
}

pub async fn run(args: &[String]) -> Result<i32, String> {
    let options = Options::parse(args)?;
    let id = generate_random_token();
    let title: String = options
        .prompt
        .lines()
        .next()
        .unwrap_or("CLI agent")
        .chars()
        .take(80)
        .collect();
    let workspace = if options.worktree {
        let path = dirs::data_local_dir()
            .ok_or("Could not locate the local app data directory")?
            .join("loors")
            .join("worktrees")
            .join(&id);
        create_worktree(&options.workspace, &path).await?;
        path
    } else {
        options.workspace
    };
    let workspace = workspace
        .to_str()
        .ok_or("Workspace path must be valid UTF-8")?;
    eprintln!("Session: {title} ({id})\nWorkspace: {workspace}");

    let args = json!({
        "session": {
            "id": id, "title": title, "workspace": workspace, "modelPath": options.model,
            "permissionMode": "ask",
        },
        "userPrompt": options.prompt, "backend": options.backend, "overrideCtx": options.context,
    });
    let state = HeadlessState::new(None, None);
    let mut events = state.events_tx.subscribe();
    let turn = dispatch_rpc(state.clone(), "run_agent_turn", args);
    tokio::pin!(turn);
    let result = {
        let interaction = async {
            while let Ok((channel, event)) = events.recv().await {
                if channel == "loors://model-load-progress" && event["stage"] == "ready" {
                    eprintln!("Model ready.");
                }
                if channel != "loors://agent-chat-event" {
                    continue;
                }
                let decision = match event["type"].as_str() {
                    Some("token") => {
                        print_token(&event);
                        continue;
                    }
                    Some("permission_requested") => {
                        let tool = event["tool_name"].as_str().unwrap_or_default();
                        let preview = event["preview"].as_str().unwrap_or_default();
                        let response = answer(format!("\n{tool} {preview}\nAllow? [y/N] ")).await;
                        (
                            "resolve_agent_permission",
                            json!({"approved": response.trim().eq_ignore_ascii_case("y")}),
                        )
                    }
                    Some("question_requested") => {
                        let question = event["question"].as_str().unwrap_or_default();
                        let response =
                            answer(format!("\n{question}\nOptions: {}\n> ", event["options"]))
                                .await;
                        let answers: Vec<_> =
                            response.trim().lines().filter(|s| !s.is_empty()).collect();
                        ("resolve_agent_question", json!({"answers": answers}))
                    }
                    _ => continue,
                };
                dispatch_rpc(
                    state.clone(),
                    decision.0,
                    json!({"sessionId": id, "decision": decision.1}),
                )
                .await?;
            }
            Err::<(), String>("Lost connection to the agent event stream".into())
        };
        tokio::pin!(interaction);
        tokio::select! {
            biased;
            res = &mut interaction => {
                state.agent.stop_turn(Some(&id));
                let _ = (&mut turn).await;
                res.map(|_| 1)
            }
            res = &mut turn => res.map(|_| 0),
            _ = tokio::signal::ctrl_c() => {
                state.agent.stop_turn(Some(&id));
                let _ = (&mut turn).await;
                Ok(130)
            }
        }
    };
    state.shutdown_agent_runtime().await;
    let status = finish_turn(result, &mut events);
    println!();
    status
}

fn finish_turn(
    result: Result<i32, String>,
    events: &mut tokio::sync::broadcast::Receiver<(String, Value)>,
) -> Result<i32, String> {
    if result? == 130 {
        return Ok(130);
    }
    while let Ok((_, event)) = events.try_recv() {
        if event["type"] == "token" {
            print_token(&event);
        }
        if event["type"] == "turn_finished" {
            return match event["status"].as_str() {
                Some("completed") => Ok(0),
                Some("cancelled") => Ok(130),
                _ => Err(event["summary"]
                    .as_str()
                    .unwrap_or("Agent failed")
                    .to_string()),
            };
        }
    }
    Err("Agent finished without a status event".to_string())
}
