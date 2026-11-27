use loors_lib::headless::{
    generate_random_token, list_models_json, list_workflows_json, resolve_dist_dir,
    run_headless_server, run_workflow_headless, status_json, HeadlessRunOptions,
    HeadlessServerConfig,
};
use serde_json::json;
use std::path::PathBuf;

#[path = "../cli_agent_command.rs"]
mod agent_command;

fn print_help() {
    println!(
        r#"loors-cli v{} — Headless AI Agent & Cyclic Harness CLI / Server

USAGE:
  loors-cli <COMMAND> [OPTIONS]

COMMANDS:
  agent [--worktree] <prompt>     Run an agent turn and save the desktop session
      --help                       Show agent options

  run <workflow.loors.json|name>   Run a harness headlessly (CI/CD, cron, SSH)
      --workspace <dir>            Override workspace folder
      --prompt <text>              Override initial prompt
      --model <path|cloud::...>    Override model path or cloud URI
      --backend <auto|cuda|vulkan|metal|cpu>
      --timeout <secs>             Max execution time in seconds
      --max-llm-calls <n>          Max LLM calls budget
      --jsonl                      Emit structured JSONL events to stdout
      --quiet                      Print only final output to stdout

  serve                            Start headless HTTP/SSE server + Web Panel
      --host <addr>                Bind address (default: 127.0.0.1)
      --port <port>                HTTP port (default: 7700)
      --token <secret>             Bearer auth token (or LOORS_TOKEN env)
      --no-auth                    Disable auth even on non-loopback host
      --dist <dir>                 Path to built frontend dist/ directory

  workflows [--json]               List saved harnesses in library
  models [--json]                  List local GGUF models and cloud providers
  status [--json]                  Show detected hardware and llama.cpp status
  help                             Show this help message
"#,
        env!("CARGO_PKG_VERSION")
    );
}

fn parse_backend_str(s: &str) -> serde_json::Value {
    match s.to_ascii_lowercase().as_str() {
        "cuda" => json!("cuda"),
        "vulkan" => json!("vulkan"),
        "metal" => json!("metal"),
        "cpu" => json!("cpu"),
        _ => json!("auto"),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || matches!(args[0].as_str(), "-h" | "--help" | "help") {
        print_help();
        return;
    }
    if matches!(args[0].as_str(), "-V" | "--version") {
        println!("loors-cli {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    match args[0].as_str() {
        "agent" => {
            if matches!(args.get(1).map(String::as_str), Some("--help" | "-h")) {
                println!("{}", agent_command::HELP);
                return;
            }
            match agent_command::run(&args[1..]).await {
                Ok(code) => std::process::exit(code),
                Err(err) => {
                    eprintln!("error: {err}");
                    std::process::exit(1);
                }
            }
        }
        "run" => {
            if args.len() < 2 {
                eprintln!("error: missing workflow path or library name.\nUsage: loors-cli run <workflow.loors.json|name> [options]");
                std::process::exit(1);
            }
            let workflow_ref = args[1].clone();
            let mut workspace = None;
            let mut prompt = None;
            let mut model = None;
            let mut backend_str = "auto".to_string();
            let mut timeout_secs = None;
            let mut max_llm_calls = None;
            let mut jsonl = false;
            let mut quiet = false;

            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--workspace" | "-w" if i + 1 < args.len() => {
                        workspace = Some(args[i + 1].clone());
                        i += 2;
                    }
                    "--prompt" | "-p" if i + 1 < args.len() => {
                        prompt = Some(args[i + 1].clone());
                        i += 2;
                    }
                    "--model" | "-m" if i + 1 < args.len() => {
                        model = Some(args[i + 1].clone());
                        i += 2;
                    }
                    "--backend" | "-b" if i + 1 < args.len() => {
                        backend_str = args[i + 1].clone();
                        i += 2;
                    }
                    "--timeout" if i + 1 < args.len() => {
                        timeout_secs = args[i + 1].parse().ok();
                        i += 2;
                    }
                    "--max-llm-calls" if i + 1 < args.len() => {
                        max_llm_calls = args[i + 1].parse().ok();
                        i += 2;
                    }
                    "--jsonl" | "--json" => {
                        jsonl = true;
                        i += 1;
                    }
                    "--quiet" | "-q" => {
                        quiet = true;
                        i += 1;
                    }
                    other => {
                        eprintln!("error: unknown option '{other}'");
                        std::process::exit(1);
                    }
                }
            }

            let backend = serde_json::from_value(parse_backend_str(&backend_str)).unwrap();
            let code = run_workflow_headless(HeadlessRunOptions {
                workflow_ref,
                workspace,
                prompt,
                model,
                backend,
                timeout_secs,
                max_llm_calls,
                jsonl,
                quiet,
            })
            .await;
            std::process::exit(code);
        }
        "serve" => {
            let mut host = "127.0.0.1".to_string();
            let mut port: u16 = 7700;
            let mut token = std::env::var("LOORS_TOKEN")
                .ok()
                .filter(|s| !s.trim().is_empty());
            let mut no_auth = false;
            let mut explicit_dist: Option<PathBuf> = None;

            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--host" if i + 1 < args.len() => {
                        host = args[i + 1].clone();
                        i += 2;
                    }
                    "--port" | "-p" if i + 1 < args.len() => {
                        port = args[i + 1].parse().unwrap_or(7700);
                        i += 2;
                    }
                    "--token" | "-t" if i + 1 < args.len() => {
                        token = Some(args[i + 1].clone());
                        i += 2;
                    }
                    "--dist" if i + 1 < args.len() => {
                        explicit_dist = Some(PathBuf::from(&args[i + 1]));
                        i += 2;
                    }
                    "--no-auth" => {
                        no_auth = true;
                        i += 1;
                    }
                    other => {
                        eprintln!("error: unknown option '{other}'");
                        std::process::exit(1);
                    }
                }
            }

            let is_loopback = host == "127.0.0.1" || host == "localhost" || host == "::1";
            let effective_token = if no_auth {
                None
            } else if token.is_some() {
                token
            } else if !is_loopback {
                Some(generate_random_token())
            } else {
                None
            };

            let dist_dir = resolve_dist_dir(explicit_dist);
            if let Err(err) = run_headless_server(HeadlessServerConfig {
                host,
                port,
                token: effective_token,
                dist_dir,
            })
            .await
            {
                eprintln!("error: {err}");
                std::process::exit(1);
            }
        }
        "workflows" => {
            let val = list_workflows_json();
            if args.iter().any(|a| a == "--json") {
                println!("{}", serde_json::to_string_pretty(&val).unwrap());
            } else if let Some(arr) = val.as_array() {
                if arr.is_empty() {
                    println!("No saved harnesses in library.");
                } else {
                    for w in arr {
                        println!(
                            "  {}  ({})",
                            w["name"].as_str().unwrap_or(""),
                            w["path"].as_str().unwrap_or("")
                        );
                    }
                }
            }
        }
        "models" => {
            let val = list_models_json();
            if args.iter().any(|a| a == "--json") {
                println!("{}", serde_json::to_string_pretty(&val).unwrap());
            } else {
                println!("Local GGUF models:");
                if let Some(arr) = val["local"].as_array() {
                    if arr.is_empty() {
                        println!("  (none)");
                    } else {
                        for m in arr {
                            println!(
                                "  {} ({:.1} GB) — {}",
                                m["name"].as_str().unwrap_or(""),
                                m["size_mb"].as_u64().unwrap_or(0) as f64 / 1024.0,
                                m["path"].as_str().unwrap_or("")
                            );
                        }
                    }
                }
                println!("\nCloud / Local API providers:");
                if let Some(arr) = val["cloudProviders"].as_array() {
                    for p in arr {
                        let enabled = p["enabled"].as_bool().unwrap_or(false);
                        let count = p["models"].as_array().map(|a| a.len()).unwrap_or(0);
                        println!(
                            "  [{}] {} ({} models)",
                            if enabled { "ON " } else { "OFF" },
                            p["name"].as_str().unwrap_or(""),
                            count
                        );
                    }
                }
            }
        }
        "status" => {
            let val = status_json();
            if args.iter().any(|a| a == "--json") {
                println!("{}", serde_json::to_string_pretty(&val).unwrap());
            } else {
                println!("Loors v{}", val["version"].as_str().unwrap_or("0.1.0"));
                println!(
                    "  RAM       : {:.1} GB",
                    val["hardware"]["total_ram_mb"].as_u64().unwrap_or(0) as f64 / 1024.0
                );
                if let Some(gpus) = val["hardware"]["gpus"].as_array() {
                    for g in gpus {
                        println!(
                            "  GPU       : {} ({:?})",
                            g["name"].as_str().unwrap_or(""),
                            g["vendor"].as_str().unwrap_or("")
                        );
                    }
                }
                let installed = val["runtime"]["installed"]
                    .as_array()
                    .map(|a| a.len())
                    .unwrap_or(0);
                println!("  Runtimes  : {installed} llama.cpp binary(ies) installed");
            }
        }
        other => {
            eprintln!("error: unknown command '{other}'\n");
            print_help();
            std::process::exit(1);
        }
    }
}
