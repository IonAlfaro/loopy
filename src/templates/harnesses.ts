import {
  NODE_BLUEPRINTS,
  type LoorsFlowEdge,
  type LoorsFlowNode,
} from "../types/graph";
import { developmentTeam } from "./developmentTeam";

export interface HarnessTemplate {
  id: string;
  name: string;
  label: string;
  nodes: LoorsFlowNode[];
  edges: LoorsFlowEdge[];
}

export const HARNESS_TEMPLATES: HarnessTemplate[] = [
  developmentTeam,
  {
    id: "swarm-engineering-team",
    name: "swarm-engineering-team",
    label: "Swarm Engineering Team (Coordinator + Backend + Frontend + QA)",
    nodes: [
      {
        id: "sw-in",
        type: "loorsNode",
        position: { x: 40, y: 180 },
        data: {
          kind: "task_input",
          title: "Task Input",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.task_input.defaultConfig,
            workspace: ".",
            prompt:
              "Describe the feature or refactor you want the Swarm team to plan, implement, and verify collaboratively.",
          },
        },
      },
      {
        id: "sw-model",
        type: "loorsNode",
        position: { x: 340, y: 420 },
        data: {
          kind: "local_model",
          title: "Local / Cloud Model",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.local_model.defaultConfig,
          },
        },
      },
      {
        id: "sw-team",
        type: "loorsNode",
        position: { x: 360, y: 140 },
        data: {
          kind: "swarm",
          title: "Engineering Swarm",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.swarm.defaultConfig,
            useWorktrees: true,
            maxRounds: 8,
            maxConcurrency: 3,
            coordinatorPrompt:
              "Decompose the engineering objective, assign tasks to @backend, @frontend, and @qa via swarm_post with @mentions, verify tests pass, and call swarm_finish with a complete delivery summary.",
            workers: [
              {
                id: "backend",
                name: "Backend",
                role: "API & Logic",
                systemPrompt:
                  "Implement backend logic and unit tests cleanly. Post concrete results to @coordinator and @qa.",
                modelPath: "",
                tools: ["list_files", "grep_search", "read_file", "edit_file", "write_file", "run_cmd"],
                maxSteps: 10,
              },
              {
                id: "frontend",
                name: "Frontend",
                role: "UI & UX",
                systemPrompt:
                  "Implement UI components and styles cleanly. Coordinate API contracts with @backend and report to @coordinator.",
                modelPath: "",
                tools: ["list_files", "grep_search", "read_file", "edit_file", "write_file", "run_cmd"],
                maxSteps: 10,
              },
              {
                id: "qa",
                name: "QA",
                role: "Tests & Audit",
                systemPrompt:
                  "Run builds/tests, inspect git_diff, and report pass or actionable failures to @coordinator.",
                modelPath: "",
                tools: ["read_file", "grep_search", "run_cmd", "git_diff"],
                maxSteps: 8,
              },
            ],
          },
        },
      },
      {
        id: "sw-judge",
        type: "loorsNode",
        position: { x: 700, y: 160 },
        data: {
          kind: "llm_judge",
          title: "Delivery Judge",
          status: "idle",
          config: {
            rubric:
              "PASS only if the Swarm completed the objective with verified tests/evidence and no unresolved blockers. Otherwise FAIL with exact items to fix.",
            inputTemplate: "## Swarm Summary\n{{swarm_output}}\n\n## Board Transcript\n{{swarm_board}}",
          },
        },
      },
      {
        id: "sw-loop",
        type: "loorsNode",
        position: { x: 700, y: 400 },
        data: {
          kind: "loop_guard",
          title: "Retry Guard (max 2)",
          status: "idle",
          config: {
            maxIterations: 2,
            feedbackTemplate:
              "RETRY {{iteration}}: The Delivery Judge rejected the previous Swarm result: {{judge_reason}}. Fix only the reported gaps and verify.",
          },
        },
      },
      {
        id: "sw-out",
        type: "loorsNode",
        position: { x: 1020, y: 160 },
        data: {
          kind: "output",
          title: "Delivered",
          status: "idle",
          config: { label: "Swarm objective delivered" },
        },
      },
    ],
    edges: [
      { id: "swe-1", source: "sw-in", sourceHandle: "exec", target: "sw-team", targetHandle: "exec" },
      {
        id: "swe-2",
        source: "sw-model",
        sourceHandle: "model_ref",
        target: "sw-team",
        targetHandle: "model_ref",
        style: { stroke: "#a855f7", strokeDasharray: "5 4" },
      },
      {
        id: "swe-3",
        source: "sw-model",
        sourceHandle: "model_ref",
        target: "sw-judge",
        targetHandle: "model_ref",
        style: { stroke: "#a855f7", strokeDasharray: "5 4" },
      },
      { id: "swe-4", source: "sw-team", sourceHandle: "exec", target: "sw-judge", targetHandle: "exec" },
      { id: "swe-5", source: "sw-judge", sourceHandle: "pass", target: "sw-out", targetHandle: "exec" },
      { id: "swe-6", source: "sw-judge", sourceHandle: "fail", target: "sw-loop", targetHandle: "exec" },
      {
        id: "swe-7",
        source: "sw-loop",
        sourceHandle: "retry",
        target: "sw-team",
        targetHandle: "feedback",
        animated: true,
        style: { stroke: "#22c55e", strokeWidth: 2 },
      },
    ],
  },
  {
    id: "autonomous-product-team",
    name: "autonomous-product-team",
    label: "Autonomous Product Team (Spec → Build → Test → QA)",
    nodes: [
      {
        id: "pt-in",
        type: "loorsNode",
        position: { x: 20, y: 200 },
        data: {
          kind: "task_input",
          title: "Product Description",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.task_input.defaultConfig,
            workspace: ".",
            prompt:
              "Describe the application you want to build (features, target users, preferred stack, and key UX goals). The autonomous engineering team will plan, implement, test, review, and deliver it end-to-end.",
            maxLlmCalls: 80,
            maxRunMinutes: 60,
          },
        },
      },
      {
        id: "pt-model",
        type: "loorsNode",
        position: { x: 300, y: 520 },
        data: {
          kind: "local_model",
          title: "Model (GGUF / API)",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.local_model.defaultConfig },
        },
      },
      {
        id: "pt-rag",
        type: "loorsNode",
        position: { x: 580, y: 520 },
        data: {
          kind: "knowledge_rag",
          title: "Codebase RAG",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.knowledge_rag.defaultConfig,
            mode: "hybrid",
            queryTemplate: "{{item}}",
          },
        },
      },
      {
        id: "pt-pm",
        type: "loorsNode",
        position: { x: 300, y: 200 },
        data: {
          kind: "agent",
          title: "PM & Architect",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.agent.defaultConfig,
            maxSteps: 12,
            systemPrompt:
              "You are the Product Manager and Software Architect.\n" +
              "1. Inspect the workspace first to see if this is a greenfield folder or an existing repo.\n" +
              "2. Write `.loors/spec.md` with crystal-clear functional requirements, UX/UI details, edge cases, and acceptance criteria.\n" +
              "3. Write `.loors/architecture.md` with the exact tech stack, folder structure, data models, API contracts, and exact build/test commands.\n" +
              "4. Create `.loors/progress.md` initialized with '# Engineering Progress\\n'.\n" +
              "5. Your FINAL response MUST be ONLY a valid JSON array of 4 to 8 ordered, atomic, self-contained engineering tasks (strings), from scaffolding to final polish, each stating the goal and acceptance criteria. No prose outside the JSON array.",
          },
        },
      },
      {
        id: "pt-val",
        type: "loorsNode",
        position: { x: 580, y: 200 },
        data: {
          kind: "json_validator",
          title: "Validate Backlog JSON",
          status: "idle",
          config: {
            sourceTemplate: "{{agent_output}}",
            expectType: "array",
            requiredKeys: "",
          },
        },
      },
      {
        id: "pt-plan-guard",
        type: "loorsNode",
        position: { x: 580, y: 20 },
        data: {
          kind: "loop_guard",
          title: "Plan Retry Guard",
          status: "idle",
          config: {
            maxIterations: 2,
            feedbackTemplate:
              "Your backlog failed JSON array validation ({{stderr}}). Return ONLY a valid JSON array of atomic task strings, e.g. [\"1. Scaffold project...\", \"2. Implement...\"].",
          },
        },
      },
      {
        id: "pt-each",
        type: "loorsNode",
        position: { x: 860, y: 200 },
        data: {
          kind: "for_each",
          title: "For Each Task",
          status: "idle",
          config: {
            itemsSource: "{{custom_output}}",
            splitMode: "auto",
            maxItems: 12,
          },
        },
      },
      {
        id: "pt-eng",
        type: "loorsNode",
        position: { x: 1140, y: 200 },
        data: {
          kind: "agent",
          title: "Senior Engineer",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.agent.defaultConfig,
            maxSteps: 18,
            systemPrompt:
              "You are a Senior Full-Stack Engineer executing task {{item_index}}/{{item_total}}:\n" +
              "TASK: {{item}}\n\n" +
              "Rules:\n" +
              "- Read `.loors/spec.md`, `.loors/architecture.md`, and `.loors/progress.md` for full context before editing.\n" +
              "- Implement ONLY this task cleanly with production-grade code and unit tests where appropriate.\n" +
              "- Run local build/typecheck commands via shell to verify your changes compile cleanly before finishing.\n" +
              "- Never leave placeholders or broken imports. Summarize the exact files changed and verification performed.",
          },
        },
      },
      {
        id: "pt-verify",
        type: "loorsNode",
        position: { x: 1420, y: 200 },
        data: {
          kind: "shell",
          title: "Build & Test",
          status: "idle",
          config: {
            command:
              "if (Test-Path .loors/verify.ps1) { & powershell -ExecutionPolicy Bypass -File .loors/verify.ps1 } elseif (Test-Path package.json) { npm run build; if ($LASTEXITCODE -eq 0 -and (Select-String -Path package.json -Pattern '\"test\"' -Quiet)) { npm test -- --watchAll=false 2>$null; if ($LASTEXITCODE -ne 0) { npm test } } } elseif (Test-Path Cargo.toml) { cargo test } elseif (Test-Path pyproject.toml) { pytest } else { Write-Output 'No standard build manifest detected yet.' }",
            timeoutSec: 240,
          },
        },
      },
      {
        id: "pt-diff",
        type: "loorsNode",
        position: { x: 1700, y: 200 },
        data: {
          kind: "git_checkpoint",
          title: "Capture Git Diff",
          status: "idle",
          config: {
            mode: "diff",
          },
        },
      },
      {
        id: "pt-judge",
        type: "loorsNode",
        position: { x: 1980, y: 200 },
        data: {
          kind: "llm_judge",
          title: "Tech Lead Review",
          status: "idle",
          config: {
            rubric:
              "Approve (PASS) ONLY if: (1) exit_code == 0 (build & tests pass without errors), (2) the code changes cleanly implement the assigned task without placeholders or regressions. Otherwise return FAIL with specific, actionable fixes.",
            inputTemplate:
              "Task {{item_index}}/{{item_total}}: {{item}}\nExit code: {{exit_code}}\nStdout:\n{{stdout}}\nStderr:\n{{stderr}}\nAgent summary:\n{{agent_output}}\nGit diff:\n{{git_diff}}",
          },
        },
      },
      {
        id: "pt-task-guard",
        type: "loorsNode",
        position: { x: 1560, y: 460 },
        data: {
          kind: "loop_guard",
          title: "Task Retry Guard (max 3)",
          status: "idle",
          config: {
            maxIterations: 3,
            feedbackTemplate:
              "Tech Lead / Build check FAILED for task '{{item}}' (exit_code={{exit_code}}).\nReview & errors:\n{{stderr}}\nFix the root cause completely and re-verify.",
          },
        },
      },
      {
        id: "pt-mem",
        type: "loorsNode",
        position: { x: 2260, y: 200 },
        data: {
          kind: "memory_file",
          title: "Record Progress",
          status: "idle",
          config: {
            mode: "append",
            filePath: ".loors/progress.md",
            template:
              "\n## Task {{item_index}}/{{item_total}} — {{item}}\n- Build exit_code: {{exit_code}}\n- Summary: {{agent_output}}\n",
          },
        },
      },
      {
        id: "pt-qa",
        type: "loorsNode",
        position: { x: 1140, y: 20 },
        data: {
          kind: "agent",
          title: "QA & Delivery Lead",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.agent.defaultConfig,
            maxSteps: 12,
            systemPrompt:
              "You are the QA & Release Lead.\n" +
              "1. Read `.loors/spec.md`, `.loors/architecture.md`, and `.loors/progress.md`.\n" +
              "2. Run the full project build/test suite and verify every requirement from `.loors/spec.md` is met with zero broken files or TODO placeholders. Fix any minor integration issue you find.\n" +
              "3. Write `.loors/delivery-report.md` summarizing the delivered product, architecture, key files, verification results, and exact commands to run the app.",
          },
        },
      },
      {
        id: "pt-out",
        type: "loorsNode",
        position: { x: 1460, y: 20 },
        data: {
          kind: "output",
          title: "Product Delivered",
          status: "idle",
          config: {
            label: "Autonomous product build complete — see .loors/delivery-report.md",
          },
        },
      },
    ],
    edges: [
      { id: "ept-1", source: "pt-in", sourceHandle: "exec", target: "pt-pm", targetHandle: "exec" },
      { id: "ept-m1", source: "pt-model", sourceHandle: "model_ref", target: "pt-pm", targetHandle: "model_ref", style: { stroke: "#a855f7", strokeDasharray: "5 4" } },
      { id: "ept-m2", source: "pt-model", sourceHandle: "model_ref", target: "pt-eng", targetHandle: "model_ref", style: { stroke: "#a855f7", strokeDasharray: "5 4" } },
      { id: "ept-m3", source: "pt-model", sourceHandle: "model_ref", target: "pt-judge", targetHandle: "model_ref", style: { stroke: "#a855f7", strokeDasharray: "5 4" } },
      { id: "ept-m4", source: "pt-model", sourceHandle: "model_ref", target: "pt-qa", targetHandle: "model_ref", style: { stroke: "#a855f7", strokeDasharray: "5 4" } },
      { id: "ept-rag1", source: "pt-rag", sourceHandle: "knowledge_ref", target: "pt-pm", targetHandle: "knowledge_ref", style: { stroke: "#06b6d4", strokeDasharray: "5 4" } },
      { id: "ept-rag2", source: "pt-rag", sourceHandle: "knowledge_ref", target: "pt-eng", targetHandle: "knowledge_ref", style: { stroke: "#06b6d4", strokeDasharray: "5 4" } },
      { id: "ept-rag3", source: "pt-rag", sourceHandle: "knowledge_ref", target: "pt-qa", targetHandle: "knowledge_ref", style: { stroke: "#06b6d4", strokeDasharray: "5 4" } },
      { id: "ept-2", source: "pt-pm", sourceHandle: "exec", target: "pt-val", targetHandle: "exec" },
      { id: "ept-val-ok", source: "pt-val", sourceHandle: "valid", target: "pt-each", targetHandle: "exec", style: { stroke: "#22c55e" }, label: "valid" },
      { id: "ept-val-bad", source: "pt-val", sourceHandle: "invalid", target: "pt-plan-guard", targetHandle: "exec", style: { stroke: "#ef4444" }, label: "invalid" },
      { id: "ept-plan-retry", source: "pt-plan-guard", sourceHandle: "retry", target: "pt-pm", targetHandle: "feedback", animated: true, style: { stroke: "#f59e0b", strokeWidth: 2 }, label: "fix JSON" },
      { id: "ept-each", source: "pt-each", sourceHandle: "each", target: "pt-eng", targetHandle: "exec", label: "task" },
      { id: "ept-done", source: "pt-each", sourceHandle: "done", target: "pt-qa", targetHandle: "exec", style: { stroke: "#22c55e" }, label: "all done" },
      { id: "ept-3", source: "pt-eng", sourceHandle: "exec", target: "pt-verify", targetHandle: "exec" },
      { id: "ept-4", source: "pt-verify", sourceHandle: "exec", target: "pt-diff", targetHandle: "exec" },
      { id: "ept-5", source: "pt-diff", sourceHandle: "exec", target: "pt-judge", targetHandle: "exec" },
      { id: "ept-pass", source: "pt-judge", sourceHandle: "pass", target: "pt-mem", targetHandle: "exec", style: { stroke: "#22c55e" }, label: "pass" },
      { id: "ept-fail", source: "pt-judge", sourceHandle: "fail", target: "pt-task-guard", targetHandle: "exec", style: { stroke: "#ef4444" }, label: "fail" },
      { id: "ept-retry", source: "pt-task-guard", sourceHandle: "retry", target: "pt-eng", targetHandle: "feedback", animated: true, style: { stroke: "#f59e0b", strokeWidth: 2 }, label: "fix & retry" },
      { id: "ept-next", source: "pt-mem", sourceHandle: "exec", target: "pt-each", targetHandle: "exec", animated: true, style: { stroke: "#8b5cf6", strokeWidth: 2 }, label: "next task" },
      { id: "ept-qa-out", source: "pt-qa", sourceHandle: "exec", target: "pt-out", targetHandle: "exec", style: { stroke: "#22c55e" } },
    ],
  },
  {
    id: "fix-tests-loop",
    name: "fix-tests-loop",
    label: "Coder ↔ Tester Loop",
    nodes: [
      {
        id: "input-1",
        type: "loorsNode",
        position: { x: 40, y: 180 },
        data: {
          kind: "task_input",
          title: "Task Input",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.task_input.defaultConfig },
        },
      },
      {
        id: "model-1",
        type: "loorsNode",
        position: { x: 40, y: 380 },
        data: {
          kind: "local_model",
          title: "Local Model (GGUF)",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.local_model.defaultConfig },
        },
      },
      {
        id: "agent-1",
        type: "loorsNode",
        position: { x: 340, y: 200 },
        data: {
          kind: "agent",
          title: "Agent: Coder",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.agent.defaultConfig },
        },
      },
      {
        id: "shell-1",
        type: "loorsNode",
        position: { x: 640, y: 200 },
        data: {
          kind: "shell",
          title: "Shell: Run Tests",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.shell.defaultConfig },
        },
      },
      {
        id: "cond-1",
        type: "loorsNode",
        position: { x: 920, y: 200 },
        data: {
          kind: "condition",
          title: "Tests Pass?",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.condition.defaultConfig },
        },
      },
      {
        id: "guard-1",
        type: "loorsNode",
        position: { x: 640, y: 420 },
        data: {
          kind: "loop_guard",
          title: "Loop Guard (max 5)",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.loop_guard.defaultConfig },
        },
      },
      {
        id: "out-1",
        type: "loorsNode",
        position: { x: 1200, y: 150 },
        data: {
          kind: "output",
          title: "Done",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.output.defaultConfig },
        },
      },
    ],
    edges: [
      { id: "e-in-agent", source: "input-1", sourceHandle: "exec", target: "agent-1", targetHandle: "exec" },
      { id: "e-model-agent", source: "model-1", sourceHandle: "model_ref", target: "agent-1", targetHandle: "model_ref", style: { stroke: "#a855f7", strokeDasharray: "5 4" } },
      { id: "e-agent-shell", source: "agent-1", sourceHandle: "exec", target: "shell-1", targetHandle: "exec" },
      { id: "e-shell-cond", source: "shell-1", sourceHandle: "exec", target: "cond-1", targetHandle: "exec" },
      { id: "e-cond-out", source: "cond-1", sourceHandle: "true", target: "out-1", targetHandle: "exec", style: { stroke: "#22c55e" }, label: "pass" },
      { id: "e-cond-guard", source: "cond-1", sourceHandle: "false", target: "guard-1", targetHandle: "exec", style: { stroke: "#ef4444" }, label: "fail" },
      { id: "e-guard-agent", source: "guard-1", sourceHandle: "retry", target: "agent-1", targetHandle: "feedback", animated: true, style: { stroke: "#22c55e", strokeWidth: 2 }, label: "loop retry" },
    ],
  },
  {
    id: "coder-review-human",
    name: "coder-review-human",
    label: "Coder → Diff → Human Gate",
    nodes: [
      {
        id: "in-1",
        type: "loorsNode",
        position: { x: 30, y: 160 },
        data: {
          kind: "task_input",
          title: "Task Input",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.task_input.defaultConfig },
        },
      },
      {
        id: "m-1",
        type: "loorsNode",
        position: { x: 30, y: 360 },
        data: {
          kind: "local_model",
          title: "Local Model (GGUF)",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.local_model.defaultConfig },
        },
      },
      {
        id: "coder-1",
        type: "loorsNode",
        position: { x: 310, y: 180 },
        data: {
          kind: "agent",
          title: "Agent: Coder",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.agent.defaultConfig },
        },
      },
      {
        id: "git-1",
        type: "loorsNode",
        position: { x: 590, y: 180 },
        data: {
          kind: "git_checkpoint",
          title: "Git Diff",
          status: "idle",
          config: { mode: "diff" },
        },
      },
      {
        id: "gate-1",
        type: "loorsNode",
        position: { x: 870, y: 180 },
        data: {
          kind: "human_gate",
          title: "Human Review",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.human_gate.defaultConfig },
        },
      },
      {
        id: "done-1",
        type: "loorsNode",
        position: { x: 1160, y: 140 },
        data: {
          kind: "output",
          title: "Aprobado",
          status: "idle",
          config: { label: "Cambios aprobados por humano" },
        },
      },
    ],
    edges: [
      { id: "eh-1", source: "in-1", sourceHandle: "exec", target: "coder-1", targetHandle: "exec" },
      { id: "eh-m", source: "m-1", sourceHandle: "model_ref", target: "coder-1", targetHandle: "model_ref", style: { stroke: "#a855f7", strokeDasharray: "5 4" } },
      { id: "eh-2", source: "coder-1", sourceHandle: "exec", target: "git-1", targetHandle: "exec" },
      { id: "eh-3", source: "git-1", sourceHandle: "exec", target: "gate-1", targetHandle: "exec" },
      { id: "eh-ok", source: "gate-1", sourceHandle: "approved", target: "done-1", targetHandle: "exec", style: { stroke: "#22c55e" }, label: "approved" },
      { id: "eh-fb", source: "gate-1", sourceHandle: "rejected", target: "coder-1", targetHandle: "feedback", animated: true, style: { stroke: "#eab308", strokeWidth: 2 }, label: "human feedback" },
    ],
  },
  {
    id: "safe-refactor-rollback",
    name: "safe-refactor-rollback",
    label: "Safe Refactor + Compactor + Rollback",
    nodes: [
      {
        id: "sr-in",
        type: "loorsNode",
        position: { x: 20, y: 180 },
        data: {
          kind: "task_input",
          title: "Task Input",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.task_input.defaultConfig },
        },
      },
      {
        id: "sr-snap",
        type: "loorsNode",
        position: { x: 280, y: 180 },
        data: {
          kind: "git_checkpoint",
          title: "Git Snapshot",
          status: "idle",
          config: { mode: "snapshot" },
        },
      },
      {
        id: "sr-agent",
        type: "loorsNode",
        position: { x: 540, y: 180 },
        data: {
          kind: "agent",
          title: "Agent: Refactor",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.agent.defaultConfig },
        },
      },
      {
        id: "sr-shell",
        type: "loorsNode",
        position: { x: 800, y: 180 },
        data: {
          kind: "shell",
          title: "Run Tests",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.shell.defaultConfig },
        },
      },
      {
        id: "sr-cond",
        type: "loorsNode",
        position: { x: 1060, y: 180 },
        data: {
          kind: "condition",
          title: "Pass?",
          status: "idle",
          config: { expression: "exit_code == 0" },
        },
      },
      {
        id: "sr-rb",
        type: "loorsNode",
        position: { x: 960, y: 390 },
        data: {
          kind: "git_checkpoint",
          title: "Git Rollback",
          status: "idle",
          config: { mode: "rollback" },
        },
      },
      {
        id: "sr-comp",
        type: "loorsNode",
        position: { x: 700, y: 390 },
        data: {
          kind: "context_compactor",
          title: "Context Compactor",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.context_compactor.defaultConfig },
        },
      },
      {
        id: "sr-guard",
        type: "loorsNode",
        position: { x: 430, y: 390 },
        data: {
          kind: "loop_guard",
          title: "Loop Guard (max 4)",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.loop_guard.defaultConfig, maxIterations: 4 },
        },
      },
      {
        id: "sr-out",
        type: "loorsNode",
        position: { x: 1320, y: 140 },
        data: {
          kind: "output",
          title: "Refactor OK",
          status: "idle",
          config: { label: "Refactor verificado" },
        },
      },
    ],
    edges: [
      { id: "esr-1", source: "sr-in", sourceHandle: "exec", target: "sr-snap", targetHandle: "exec" },
      { id: "esr-2", source: "sr-snap", sourceHandle: "exec", target: "sr-agent", targetHandle: "exec" },
      { id: "esr-3", source: "sr-agent", sourceHandle: "exec", target: "sr-shell", targetHandle: "exec" },
      { id: "esr-4", source: "sr-shell", sourceHandle: "exec", target: "sr-cond", targetHandle: "exec" },
      { id: "esr-ok", source: "sr-cond", sourceHandle: "true", target: "sr-out", targetHandle: "exec", style: { stroke: "#22c55e" } },
      { id: "esr-fail", source: "sr-cond", sourceHandle: "false", target: "sr-rb", targetHandle: "exec", style: { stroke: "#ef4444" } },
      { id: "esr-comp", source: "sr-rb", sourceHandle: "exec", target: "sr-comp", targetHandle: "exec" },
      { id: "esr-guard", source: "sr-comp", sourceHandle: "exec", target: "sr-guard", targetHandle: "exec" },
      { id: "esr-retry", source: "sr-guard", sourceHandle: "retry", target: "sr-agent", targetHandle: "feedback", animated: true, style: { stroke: "#22c55e", strokeWidth: 2 }, label: "retry clean" },
    ],
  },
  {
    id: "autonomous-dev-loop",
    name: "autonomous-dev-loop",
    label: "Autonomous Dev Loop (Reflect → Build → Judge)",
    nodes: [
      {
        id: "ad-in",
        type: "loorsNode",
        position: { x: 20, y: 180 },
        data: {
          kind: "task_input",
          title: "Visión del Proyecto",
          status: "idle",
          config: {
            workspace: ".",
            prompt:
              "Desarrolla y mejora iterativamente el proyecto: detecta qué falla, qué falta, qué incluir y cómo pulirlo.",
          },
        },
      },
      {
        id: "ad-model",
        type: "loorsNode",
        position: { x: 20, y: 390 },
        data: {
          kind: "local_model",
          title: "Local Model (GGUF)",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.local_model.defaultConfig },
        },
      },
      {
        id: "ad-mem-r",
        type: "loorsNode",
        position: { x: 290, y: 180 },
        data: {
          kind: "memory_file",
          title: "Leer BACKLOG.md",
          status: "idle",
          config: { mode: "read", filePath: ".loors/BACKLOG.md", template: "" },
        },
      },
      {
        id: "ad-reflect",
        type: "loorsNode",
        position: { x: 560, y: 180 },
        data: {
          kind: "agent",
          title: "Director / Reflector",
          status: "idle",
          config: {
            systemPrompt:
              "Audita el proyecto actual y la memoria ({{memory}}). Identifica qué falla, qué falta y qué mejora aporta más valor. Implementa UNA sola mejora atómica y verificable.",
            tools: ["list_files", "read_file", "write_file", "run_cmd"],
            maxSteps: 0,
          },
        },
      },
      {
        id: "ad-test",
        type: "loorsNode",
        position: { x: 840, y: 180 },
        data: {
          kind: "shell",
          title: "Build & Verify",
          status: "idle",
          config: { command: "cargo test", timeoutSec: 180 },
        },
      },
      {
        id: "ad-diff",
        type: "loorsNode",
        position: { x: 1110, y: 180 },
        data: {
          kind: "git_checkpoint",
          title: "Capturar Diff",
          status: "idle",
          config: { mode: "diff" },
        },
      },
      {
        id: "ad-judge",
        type: "loorsNode",
        position: { x: 1380, y: 180 },
        data: {
          kind: "llm_judge",
          title: "Judge: ¿Mejoró?",
          status: "idle",
          config: {
            rubric:
              "Aprueba (pass) solo si los tests pasan (exit_code == 0) y el diff mejora realmente el proyecto sin regresiones.",
            inputTemplate:
              "Objetivo: {{prompt}}\nExit code: {{exit_code}}\nStderr:\n{{stderr}}\nDiff:\n{{git_diff}}",
          },
        },
      },
      {
        id: "ad-mem-w",
        type: "loorsNode",
        position: { x: 1110, y: 410 },
        data: {
          kind: "memory_file",
          title: "Guardar Progreso",
          status: "idle",
          config: {
            mode: "append",
            filePath: ".loors/BACKLOG.md",
            template:
              "## Ciclo {{iteration}} (KEEP)\n- Cambio: {{agent_output}}\n- Judge: {{judge_reason}}\n",
          },
        },
      },
      {
        id: "ad-rb",
        type: "loorsNode",
        position: { x: 1380, y: 410 },
        data: {
          kind: "git_checkpoint",
          title: "Git Rollback",
          status: "idle",
          config: { mode: "rollback" },
        },
      },
      {
        id: "ad-guard",
        type: "loorsNode",
        position: { x: 560, y: 410 },
        data: {
          kind: "loop_guard",
          title: "Ciclo Autónomo (max 15)",
          status: "idle",
          config: {
            maxIterations: 15,
            feedbackTemplate:
              "Siguiente ciclo de evolución ({{iteration}}).\nÚltima evaluación: {{judge_reason}}\nÚltimo error (si hubo): {{stderr}}\nMemoria:\n{{memory}}",
          },
        },
      },
      {
        id: "ad-out",
        type: "loorsNode",
        position: { x: 290, y: 410 },
        data: {
          kind: "output",
          title: "Ciclos Completados",
          status: "idle",
          config: { label: "Evolución autónoma finalizada" },
        },
      },
    ],
    edges: [
      { id: "ead-1", source: "ad-in", sourceHandle: "exec", target: "ad-mem-r", targetHandle: "exec" },
      { id: "ead-m1", source: "ad-model", sourceHandle: "model_ref", target: "ad-reflect", targetHandle: "model_ref", style: { stroke: "#a855f7", strokeDasharray: "5 4" } },
      { id: "ead-m2", source: "ad-model", sourceHandle: "model_ref", target: "ad-judge", targetHandle: "model_ref", style: { stroke: "#a855f7", strokeDasharray: "5 4" } },
      { id: "ead-2", source: "ad-mem-r", sourceHandle: "exec", target: "ad-reflect", targetHandle: "exec" },
      { id: "ead-3", source: "ad-reflect", sourceHandle: "exec", target: "ad-test", targetHandle: "exec" },
      { id: "ead-4", source: "ad-test", sourceHandle: "exec", target: "ad-diff", targetHandle: "exec" },
      { id: "ead-5", source: "ad-diff", sourceHandle: "exec", target: "ad-judge", targetHandle: "exec" },
      { id: "ead-keep", source: "ad-judge", sourceHandle: "pass", target: "ad-mem-w", targetHandle: "exec", style: { stroke: "#22c55e" }, label: "keep" },
      { id: "ead-rev", source: "ad-judge", sourceHandle: "fail", target: "ad-rb", targetHandle: "exec", style: { stroke: "#ef4444" }, label: "revert" },
      { id: "ead-g1", source: "ad-mem-w", sourceHandle: "exec", target: "ad-guard", targetHandle: "exec" },
      { id: "ead-g2", source: "ad-rb", sourceHandle: "exec", target: "ad-guard", targetHandle: "exec" },
      { id: "ead-loop", source: "ad-guard", sourceHandle: "retry", target: "ad-mem-r", targetHandle: "exec", animated: true, style: { stroke: "#22c55e", strokeWidth: 2 }, label: "next cycle" },
      { id: "ead-end", source: "ad-guard", sourceHandle: "exhausted", target: "ad-out", targetHandle: "exec" },
    ],
  },
  {
    id: "jira-auto-fixer",
    name: "jira-auto-fixer",
    label: "Jira Ticket Auto-Fixer (API → Fix → Test → Comment)",
    nodes: [
      {
        id: "jr-in",
        type: "loorsNode",
        position: { x: 20, y: 180 },
        data: {
          kind: "task_input",
          title: "Repo & Trigger",
          status: "idle",
          config: {
            workspace: ".",
            prompt: "Resuelve el bug reportado en el ticket de Jira y asegura que todos los tests pasen.",
          },
        },
      },
      {
        id: "jr-model",
        type: "loorsNode",
        position: { x: 20, y: 390 },
        data: {
          kind: "local_model",
          title: "Local Model (GGUF)",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.local_model.defaultConfig },
        },
      },
      {
        id: "jr-fetch",
        type: "loorsNode",
        position: { x: 290, y: 180 },
        data: {
          kind: "http_request",
          title: "Jira: Leer Ticket",
          status: "idle",
          config: {
            method: "GET",
            url: "https://tu-empresa.atlassian.net/rest/api/3/issue/PROJ-123",
            headersJson: "{\n  \"Authorization\": \"Basic ${JIRA_AUTH_B64}\",\n  \"Accept\": \"application/json\"\n}",
            bodyTemplate: "",
          },
        },
      },
      {
        id: "jr-comp",
        type: "loorsNode",
        position: { x: 560, y: 180 },
        data: {
          kind: "context_compactor",
          title: "Contexto Ticket",
          status: "idle",
          config: {
            maxChars: 5000,
            template: "Objetivo: {{prompt}}\nTicket Jira:\n{{http_response}}\nÚltimo error:\n{{stderr}}",
          },
        },
      },
      {
        id: "jr-coder",
        type: "loorsNode",
        position: { x: 830, y: 180 },
        data: {
          kind: "agent",
          title: "Agent: Bug Fixer",
          status: "idle",
          config: {
            systemPrompt:
              "Analiza el ticket de Jira, reproduce el fallo, aplica el fix mínimo y añade/actualiza tests.",
            tools: ["list_files", "read_file", "write_file", "run_cmd"],
            maxSteps: 0,
          },
        },
      },
      {
        id: "jr-test",
        type: "loorsNode",
        position: { x: 1100, y: 180 },
        data: {
          kind: "shell",
          title: "Run Test Suite",
          status: "idle",
          config: { command: "npm test", timeoutSec: 180 },
        },
      },
      {
        id: "jr-judge",
        type: "loorsNode",
        position: { x: 1370, y: 180 },
        data: {
          kind: "llm_judge",
          title: "Judge: ¿Bug resuelto?",
          status: "idle",
          config: {
            rubric: "Aprueba solo si exit_code == 0 y el fix resuelve la causa raíz del ticket de Jira.",
            inputTemplate: "Ticket:\n{{http_response}}\nExit code: {{exit_code}}\nStderr:\n{{stderr}}\nDiff:\n{{git_diff}}",
          },
        },
      },
      {
        id: "jr-guard",
        type: "loorsNode",
        position: { x: 1100, y: 400 },
        data: {
          kind: "loop_guard",
          title: "Retry Loop (max 6)",
          status: "idle",
          config: {
            maxIterations: 6,
            feedbackTemplate:
              "El intento anterior no pasó verificación.\nJudge: {{judge_reason}}\nStderr:\n{{stderr}}",
          },
        },
      },
      {
        id: "jr-comment",
        type: "loorsNode",
        position: { x: 1640, y: 150 },
        data: {
          kind: "http_request",
          title: "Jira: Comentar Fix",
          status: "idle",
          config: {
            method: "POST",
            url: "https://tu-empresa.atlassian.net/rest/api/3/issue/PROJ-123/comment",
            headersJson: "{\n  \"Authorization\": \"Basic ${JIRA_AUTH_B64}\"\n}",
            bodyTemplate: "{\n  \"body\": \"Fix aplicado y verificado por Loors: {{judge_reason}}\"\n}",
          },
        },
      },
      {
        id: "jr-out",
        type: "loorsNode",
        position: { x: 1910, y: 150 },
        data: {
          kind: "output",
          title: "Ticket Resuelto",
          status: "idle",
          config: { label: "Ticket Jira corregido y verificado" },
        },
      },
    ],
    edges: [
      { id: "ej-1", source: "jr-in", sourceHandle: "exec", target: "jr-fetch", targetHandle: "exec" },
      { id: "ej-m1", source: "jr-model", sourceHandle: "model_ref", target: "jr-coder", targetHandle: "model_ref", style: { stroke: "#a855f7", strokeDasharray: "5 4" } },
      { id: "ej-m2", source: "jr-model", sourceHandle: "model_ref", target: "jr-judge", targetHandle: "model_ref", style: { stroke: "#a855f7", strokeDasharray: "5 4" } },
      { id: "ej-2", source: "jr-fetch", sourceHandle: "ok", target: "jr-comp", targetHandle: "exec" },
      { id: "ej-3", source: "jr-comp", sourceHandle: "exec", target: "jr-coder", targetHandle: "exec" },
      { id: "ej-4", source: "jr-coder", sourceHandle: "exec", target: "jr-test", targetHandle: "exec" },
      { id: "ej-5", source: "jr-test", sourceHandle: "exec", target: "jr-judge", targetHandle: "exec" },
      { id: "ej-ok", source: "jr-judge", sourceHandle: "pass", target: "jr-comment", targetHandle: "exec", style: { stroke: "#22c55e" }, label: "solved" },
      { id: "ej-fail", source: "jr-judge", sourceHandle: "fail", target: "jr-guard", targetHandle: "exec", style: { stroke: "#ef4444" }, label: "retry" },
      { id: "ej-loop", source: "jr-guard", sourceHandle: "retry", target: "jr-coder", targetHandle: "feedback", animated: true, style: { stroke: "#22c55e", strokeWidth: 2 }, label: "fix loop" },
      { id: "ej-done", source: "jr-comment", sourceHandle: "ok", target: "jr-out", targetHandle: "exec" },
    ],
  },
  {
    id: "batch-json-validator-loop",
    name: "batch-json-validator-loop",
    label: "Batch JSON Loop (For Each + Validator)",
    nodes: [
      {
        id: "bj-in",
        type: "loorsNode",
        position: { x: 20, y: 180 },
        data: {
          kind: "task_input",
          title: "Task Input (Budgeted)",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.task_input.defaultConfig,
            prompt:
              "Process each item from the batch list and emit a structured JSON report with keys: item, status, summary.",
            maxLlmCalls: 30,
            maxRunMinutes: 15,
          },
        },
      },
      {
        id: "bj-list",
        type: "loorsNode",
        position: { x: 280, y: 180 },
        data: {
          kind: "shell",
          title: "Collect Items (JSON)",
          status: "idle",
          config: {
            command: "echo '[\"auth\", \"billing\", \"search\"]'",
            timeoutSec: 30,
          },
        },
      },
      {
        id: "bj-each",
        type: "loorsNode",
        position: { x: 540, y: 180 },
        data: {
          kind: "for_each",
          title: "For Each Item",
          status: "idle",
          config: {
            itemsSource: "{{stdout}}",
            splitMode: "auto",
            maxItems: 20,
          },
        },
      },
      {
        id: "bj-model",
        type: "loorsNode",
        position: { x: 540, y: 400 },
        data: {
          kind: "local_model",
          title: "Local Model",
          status: "idle",
          config: { ...NODE_BLUEPRINTS.local_model.defaultConfig },
        },
      },
      {
        id: "bj-skill",
        type: "loorsNode",
        position: { x: 540, y: 560 },
        data: {
          kind: "skill",
          title: "Strict JSON Skill",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.skill.defaultConfig,
            mode: "inject",
            inlineInstructions:
              "Always respond with a single valid JSON object containing keys: item, status, summary. Do not add prose outside the JSON.",
          },
        },
      },
      {
        id: "bj-agent",
        type: "loorsNode",
        position: { x: 830, y: 180 },
        data: {
          kind: "agent",
          title: "Agent: Process Item",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.agent.defaultConfig,
            systemPrompt:
              "Analyze item {{item_index}}/{{item_total}}: {{item}}.\nReturn ONLY a JSON object with keys: item, status, summary.",
            maxSteps: 6,
          },
        },
      },
      {
        id: "bj-val",
        type: "loorsNode",
        position: { x: 1120, y: 180 },
        data: {
          kind: "json_validator",
          title: "Validate JSON Schema",
          status: "idle",
          config: {
            sourceTemplate: "{{agent_output}}",
            expectType: "object",
            requiredKeys: "item, status, summary",
          },
        },
      },
      {
        id: "bj-guard",
        type: "loorsNode",
        position: { x: 830, y: 420 },
        data: {
          kind: "loop_guard",
          title: "JSON Retry Guard",
          status: "idle",
          config: {
            maxIterations: 12,
            feedbackTemplate:
              "Your previous response for '{{item}}' failed JSON validation: {{stderr}}. Fix it and return ONLY valid JSON with keys: item, status, summary.",
          },
        },
      },
      {
        id: "bj-mem",
        type: "loorsNode",
        position: { x: 1400, y: 180 },
        data: {
          kind: "memory_file",
          title: "Append Valid Result",
          status: "idle",
          config: {
            mode: "append",
            filePath: ".loors/batch-results.jsonl",
            template: "{{custom_output}}",
          },
        },
      },
      {
        id: "bj-out",
        type: "loorsNode",
        position: { x: 830, y: 20 },
        data: {
          kind: "output",
          title: "Batch Complete",
          status: "idle",
          config: {
            label: "All items processed and validated into .loors/batch-results.jsonl",
          },
        },
      },
    ],
    edges: [
      { id: "ebj-1", source: "bj-in", sourceHandle: "exec", target: "bj-list", targetHandle: "exec" },
      { id: "ebj-2", source: "bj-list", sourceHandle: "exec", target: "bj-each", targetHandle: "exec" },
      { id: "ebj-m", source: "bj-model", sourceHandle: "model_ref", target: "bj-agent", targetHandle: "model_ref", style: { stroke: "#a855f7", strokeDasharray: "5 4" } },
      { id: "ebj-sk", source: "bj-skill", sourceHandle: "skill_ref", target: "bj-agent", targetHandle: "skill_ref", style: { stroke: "#ec4899", strokeDasharray: "5 4" } },
      { id: "ebj-each", source: "bj-each", sourceHandle: "each", target: "bj-agent", targetHandle: "exec", label: "each" },
      { id: "ebj-done", source: "bj-each", sourceHandle: "done", target: "bj-out", targetHandle: "exec", style: { stroke: "#22c55e" }, label: "done" },
      { id: "ebj-3", source: "bj-agent", sourceHandle: "exec", target: "bj-val", targetHandle: "exec" },
      { id: "ebj-ok", source: "bj-val", sourceHandle: "valid", target: "bj-mem", targetHandle: "exec", style: { stroke: "#22c55e" }, label: "valid" },
      { id: "ebj-bad", source: "bj-val", sourceHandle: "invalid", target: "bj-guard", targetHandle: "exec", style: { stroke: "#ef4444" }, label: "invalid" },
      { id: "ebj-retry", source: "bj-guard", sourceHandle: "retry", target: "bj-agent", targetHandle: "feedback", animated: true, style: { stroke: "#f59e0b", strokeWidth: 2 }, label: "fix JSON" },
      { id: "ebj-next", source: "bj-mem", sourceHandle: "exec", target: "bj-each", targetHandle: "exec", animated: true, style: { stroke: "#8b5cf6", strokeWidth: 2 }, label: "next item" },
    ],
  },
];
