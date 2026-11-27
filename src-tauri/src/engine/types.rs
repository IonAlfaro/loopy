use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowGraph {
    #[serde(default)]
    pub name: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub data: GraphNodeData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNodeData {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub config: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub source_handle: Option<String>,
    pub target: String,
    pub target_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatusKind {
    Idle,
    Running,
    Success,
    Error,
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogStreamKind {
    System,
    Stdout,
    Stderr,
    Agent,
    Thinking,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcomeKind {
    Completed,
    Exhausted,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    RunStarted {
        run_id: String,
        workflow_name: String,
    },
    NodeStatus {
        run_id: String,
        node_id: String,
        status: NodeStatusKind,
        iteration: u32,
        message: Option<String>,
    },
    NodeLog {
        run_id: String,
        node_id: String,
        node_title: String,
        iteration: u32,
        stream: LogStreamKind,
        text: String,
    },
    IterationChanged {
        run_id: String,
        iteration: u32,
        max_iterations: u32,
    },
    ModelState {
        loaded: bool,
        model_name: Option<String>,
        context_size: Option<u32>,
    },
    HumanGateWaiting {
        run_id: String,
        node_id: String,
        node_title: String,
        iteration: u32,
        message: String,
        git_diff: String,
    },
    SwarmAgentStatus {
        run_id: String,
        node_id: String,
        agent_id: String,
        agent_name: String,
        role: String,
        status: String,
        summary: String,
    },
    SwarmBoardMessage {
        run_id: String,
        node_id: String,
        seq: u64,
        from: String,
        mentions: Vec<String>,
        content: String,
        timestamp: String,
    },
    RunFinished {
        run_id: String,
        outcome: RunOutcomeKind,
        total_iterations: u32,
        summary: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HumanDecision {
    pub approved: bool,
    pub feedback: Option<String>,
}

#[derive(Debug, Default)]
pub struct ExecutionContext {
    pub workspace: String,
    pub initial_prompt: String,
    pub current_prompt: String,
    pub iteration: u32,
    pub last_exit_code: Option<i32>,
    pub last_stdout: String,
    pub last_stderr: String,
    pub last_agent_output: String,
    pub last_git_diff: String,
    pub last_memory: String,
    pub last_judge_reason: String,
    pub last_http_response: String,
    pub last_http_status: Option<u16>,
    pub last_custom_output: String,
    pub last_rag_context: String,
    pub last_swarm_output: String,
    pub last_swarm_board: String,
    pub node_outputs: HashMap<String, String>,
    pub loop_ledger: Vec<String>,
    pub loop_counts: HashMap<String, u32>,
    pub for_each_queues: HashMap<String, Vec<String>>,
    pub for_each_index: HashMap<String, usize>,
    pub current_item: String,
    pub current_item_index: usize,
    pub current_item_total: usize,
    pub llm_call_count: usize,
    pub max_llm_calls: usize,
    pub max_run_secs: u64,
}

impl ExecutionContext {
    pub fn render_template(&self, template: &str) -> String {
        let mut out = template
            .replace("{{prompt}}", &self.initial_prompt)
            .replace("{{current_prompt}}", &self.current_prompt)
            .replace("{{stdout}}", &self.last_stdout)
            .replace("{{stderr}}", &self.last_stderr)
            .replace("{{agent_output}}", &self.last_agent_output)
            .replace("{{git_diff}}", &self.last_git_diff)
            .replace("{{memory}}", &self.last_memory)
            .replace("{{judge_reason}}", &self.last_judge_reason)
            .replace("{{http_response}}", &self.last_http_response)
            .replace("{{custom_output}}", &self.last_custom_output)
            .replace("{{rag_context}}", &self.last_rag_context)
            .replace("{{swarm_output}}", &self.last_swarm_output)
            .replace("{{swarm_board}}", &self.last_swarm_board)
            .replace("{{item}}", &self.current_item)
            .replace("{{item_index}}", &self.current_item_index.to_string())
            .replace("{{item_total}}", &self.current_item_total.to_string())
            .replace("{{loop_ledger}}", &self.loop_ledger.join("\n"))
            .replace(
                "{{http_status}}",
                &self
                    .last_http_status
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "none".to_string()),
            )
            .replace("{{iteration}}", &self.iteration.to_string())
            .replace(
                "{{exit_code}}",
                &self
                    .last_exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "none".to_string()),
            );

        for (k, v) in &self.node_outputs {
            let pat = format!("{{{{node:{k}}}}}");
            if out.contains(&pat) {
                out = out.replace(&pat, v);
            }
        }
        out
    }
}
