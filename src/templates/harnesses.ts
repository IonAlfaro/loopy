import {
  NODE_BLUEPRINTS,
  type LoopyFlowEdge,
  type LoopyFlowNode,
} from "../types/graph";

export interface HarnessTemplate {
  id: string;
  name: string;
  label: string;
  nodes: LoopyFlowNode[];
  edges: LoopyFlowEdge[];
}

export const HARNESS_TEMPLATES: HarnessTemplate[] = [
  {
    id: "fix-tests-loop",
    name: "fix-tests-loop",
    label: "Coder ↔ Tester Loop",
    nodes: [
      {
        id: "input-1",
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
        position: { x: 290, y: 180 },
        data: {
          kind: "memory_file",
          title: "Leer BACKLOG.md",
          status: "idle",
          config: { mode: "read", filePath: ".loopy/BACKLOG.md", template: "" },
        },
      },
      {
        id: "ad-reflect",
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
        position: { x: 1110, y: 410 },
        data: {
          kind: "memory_file",
          title: "Guardar Progreso",
          status: "idle",
          config: {
            mode: "append",
            filePath: ".loopy/BACKLOG.md",
            template:
              "## Ciclo {{iteration}} (KEEP)\n- Cambio: {{agent_output}}\n- Judge: {{judge_reason}}\n",
          },
        },
      },
      {
        id: "ad-rb",
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
        position: { x: 1640, y: 150 },
        data: {
          kind: "http_request",
          title: "Jira: Comentar Fix",
          status: "idle",
          config: {
            method: "POST",
            url: "https://tu-empresa.atlassian.net/rest/api/3/issue/PROJ-123/comment",
            headersJson: "{\n  \"Authorization\": \"Basic ${JIRA_AUTH_B64}\"\n}",
            bodyTemplate: "{\n  \"body\": \"Fix aplicado y verificado por Loopy: {{judge_reason}}\"\n}",
          },
        },
      },
      {
        id: "jr-out",
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
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
        type: "loopyNode",
        position: { x: 1400, y: 180 },
        data: {
          kind: "memory_file",
          title: "Append Valid Result",
          status: "idle",
          config: {
            mode: "append",
            filePath: ".loopy/batch-results.jsonl",
            template: "{{custom_output}}",
          },
        },
      },
      {
        id: "bj-out",
        type: "loopyNode",
        position: { x: 830, y: 20 },
        data: {
          kind: "output",
          title: "Batch Complete",
          status: "idle",
          config: {
            label: "All items processed and validated into .loopy/batch-results.jsonl",
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
