import { useGraphStore } from "./store/useGraphStore";
import { NODE_BLUEPRINTS, type LoorsNodeKind } from "./types/graph";

export type AppLocale = "en" | "es";

const TRANSLATIONS = {
  en: {
    // Topbar & Modes
    "nav.agent": "Agent",
    "nav.harnesses": "Harnesses",
    "nav.new": "New",
    "nav.library": "Library",
    "nav.run": "Run",
    "nav.stop": "Stop",
    "nav.runtimeTooltip": "Local runtime (llama.cpp)",
    "nav.modelsTooltip": "Local GGUF models, Hugging Face & Cloud APIs",
    "nav.updatesTooltip": "Check for Loors updates",
    "nav.languageTooltip": "Switch language (EN / ES)",

    // Harness Canvas & Sidebar
    "canvas.arrange": "Arrange",
    "canvas.wires": "Wires",
    "canvas.inspector": "Inspector",
    "canvas.architect": "AI Architect",
    "canvas.selectNodeHint": "Select a node on the canvas to edit its properties.",
    "canvas.console": "Console",
    "canvas.logs": "Logs",
    "canvas.gitDiff": "Git Diff",
    "canvas.reports": "Reports (.loors)",
    "canvas.ready": "Ready",
    "canvas.running": "Running",
    "canvas.autoScroll": "Auto",
    "canvas.consoleEmpty": "Press Run to see live thinking, token streaming, tool calls, and stdout/stderr.",
    "sidebar.searchNode": "Search node…",
    "sidebar.essentials": "Essentials",
    "sidebar.contextResources": "Context & Resources",
    "sidebar.advanced": "Advanced & Integrations",
    "sidebar.documents": "Documents",
    "sidebar.customNodes": "Custom Nodes",
    "sidebar.create": "Create",

    // Agent View
    "agent.newConversation": "New conversation",
    "agent.projects": "Projects",
    "agent.addFirstProject": "Add first project…",
    "agent.noProject": "No project",
    "agent.freeChat": "Free conversation",
    "agent.newSession": "New session",
    "agent.files": "Files",
    "agent.diff": "Diff",
    "agent.browser": "Browser",
    "agent.filterFiles": "Filter project files…",
    "agent.pickProjectTree": "Choose a project on the left to view its file tree.",
    "agent.liveBrowser": "Live browser",
    "agent.noBrowserSession": "No active browser session",
    "agent.noBrowserDesc": "The live view will appear here when the agent browses or interacts with a web page.",
    "agent.heroTitle": "What are we working on?",
    "agent.chooseOtherFolder": "+ Choose another folder…",
    "agent.composerPlaceholder": "Write a message…",
    "agent.composerQueuePlaceholder": "Queue a message…",
    "agent.chooseModel": "Choose model…",
    "agent.searchModel": "Search model or quantization…",
    "agent.noModelsYet": "No local models or active APIs yet.",
    "agent.noLocalMatches": "No matches in your local models.",
    "agent.localModelsBtn": "GGUF Models…",
    "agent.cloudApisBtn": "APIs / Cloud…",
    "agent.localPermissions": "Local permissions",
    "agent.permReadOnly": "Read-only",
    "agent.permReadOnlyDesc": "Inspect and search without editing or running commands.",
    "agent.permAsk": "Ask",
    "agent.permAskDesc": "Ask for approval before editing files or running commands.",
    "agent.permAuto": "Auto",
    "agent.permAutoDesc": "AI checks if each command is safe; only asks you if risky.",
    "agent.permTurbo": "Turbo",
    "agent.permTurboDesc": "Run edits and commands immediately without asking.",
    "agent.attachFiles": "Attach files, PDFs or images…",
    "agent.pinFile": "Pin project file…",
    "agent.noPinMatches": "No matching files in this project.",

    // Onboarding
    "onboarding.title": "Configure a local runtime or connect an API provider to get started.",
    "onboarding.optA": "Local Runtime",
    "onboarding.rtReady": "llama.cpp ready",
    "onboarding.rtInstalling": "Installing llama.cpp…",
    "onboarding.rtInstallCta": "Install llama.cpp",
    "onboarding.rtInstallDesc": "Automatic GPU detection (CUDA, Vulkan, Metal, or CPU)",
    "onboarding.rtInstalledPrefix": "Installed",
    "onboarding.ggufCta": "Select or download a GGUF model",
    "onboarding.ggufDesc": "Browse Hugging Face or use existing local models",
    "onboarding.ggufDetected": "model(s) available",
    "onboarding.optB": "Cloud & Local APIs",
    "onboarding.cloudCta": "Connect an API provider",
    "onboarding.cloudDesc": "OpenAI, Anthropic, Gemini, LM Studio, Ollama, or custom endpoints",

    // Suggestions
    "suggest.ws1": "Explore this project's architecture and summarize the key files",
    "suggest.ws2": "Review recent changes (git diff) and spot potential bugs",
    "suggest.ws3": "Find top performance improvements or technical debt",
    "suggest.free1": "Research a topic on the web and give me a structured summary with sources",
    "suggest.free2": "Help me design a script or technical architecture step by step",
    "suggest.free3": "Analyze a file, PDF, or screenshot I attach here",

    // Models & AI Modal
    "models.title": "Models & AI",
    "models.tabLocal": "Downloaded",
    "models.tabDiscover": "Explore Hugging Face",
    "models.tabCloud": "APIs / Cloud",
    "models.rescan": "Rescan",
    "models.searchLocal": "Search local models (name, family or quantization Q4, Q8…)",
    "models.emptyLocal": "No local .gguf files yet",
    "models.emptyLocalDesc": "Loors automatically detects models from LM Studio and its local folder, or you can download quantizations from Hugging Face.",
    "models.cloudHint": "Enter your API key and click Connect & load models: Loors automatically fetches available models from each provider.",
    "models.addCustom": "Add custom provider",
    "models.save": "Save",
    "models.saving": "Saving…",
    "models.baseUrl": "Base URL",
    "models.apiKey": "API Key (or ${ENV_VAR})",
    "models.connectLoad": "Connect & load models",
    "models.refreshModels": "Refresh models",
    "models.fetching": "Querying API…",
    "models.filterModels": "Filter models…",
    "models.modelsCount": "models",
    "models.close": "Close",

    // Architect Chat
    "architect.subtitle": "Visual harness designer (.loors.json)",
    "architect.placeholder": "Describe the harness…",
    "architect.queuePlaceholder": "Write another message to queue it… (Enter to queue)",
    "architect.emptyIntro": "Ask me to design a harness from scratch or improve the current canvas. You can attach files, folders, or screenshots.",
    "architect.p1": "Improve this harness and add a Devil's Advocate reviewer before the Judge.",
    "architect.p2": "Create an autonomous TDD harness (Coder -> Tests -> Loop Guard -> Human Gate).",
    "architect.p3": "Create a Jira-connected harness that reads a ticket, fixes the code, and posts a comment.",
    "architect.p4": "Review the prompts and tools of the agents in my current harness and optimize them.",
    "architect.noModels": "No local models or connected APIs.",
    "architect.configModels": "Configure models or APIs…",
    "architect.localGroup": "Local models (GGUF)",
    "architect.readTools": "6 read tools",

    // Runtime Modal
    "runtime.title": "Local Runtime (llama.cpp)",
    "runtime.backend": "Inference backend",
    "runtime.auto": "Automatic (recommended)",
    "runtime.install": "Download / Update llama.cpp",
    "runtime.done": "Done",

    // Update Modal
    "updates.title": "Loors Updates",
    "updates.installed": "Installed version",
    "updates.check": "Check for updates",
    "updates.checking": "Checking…",
    "updates.repoLabel": "GitHub Releases repository (owner/repo)",
    "updates.upToDate": "Loors is up to date",
    "updates.newAvailable": "New version available",
    "updates.viewRelease": "View release",
    "updates.downloadInstall": "Download & install",
    "updates.downloading": "Downloading update…",

    // Library Modal
    "library.title": "Harness Library (.loors.json)",
    "library.save": "Save to library",
    "library.export": "Export",
    "library.copyJson": "Copy JSON",
    "library.import": "Import",
    "library.localHeader": "LOCAL HARNESS LIBRARY",
    "library.emptyLocal": "You haven't saved any harnesses to your local library yet. You can also drag and drop a .loors.json file directly onto the canvas.",
    "library.templatesHeader": "EXAMPLE TEMPLATES",
    "library.use": "Use",
    "library.pasteLabel": "Import by pasting JSON directly",
    "library.importPasted": "Import pasted JSON",
  },
  es: {
    // Topbar & Modes
    "nav.agent": "Agente",
    "nav.harnesses": "Arneses",
    "nav.new": "Nuevo",
    "nav.library": "Biblioteca",
    "nav.run": "Ejecutar",
    "nav.stop": "Detener",
    "nav.runtimeTooltip": "Runtime local (llama.cpp)",
    "nav.modelsTooltip": "Modelos GGUF locales, Hugging Face y APIs Cloud",
    "nav.updatesTooltip": "Buscar actualizaciones de Loors",
    "nav.languageTooltip": "Cambiar idioma (EN / ES)",

    // Harness Canvas & Sidebar
    "canvas.arrange": "Ordenar",
    "canvas.wires": "Cables",
    "canvas.inspector": "Inspector",
    "canvas.architect": "Arquitecto IA",
    "canvas.selectNodeHint": "Selecciona un nodo en el lienzo para editar sus propiedades.",
    "canvas.console": "Consola",
    "canvas.logs": "Logs",
    "canvas.gitDiff": "Git Diff",
    "canvas.reports": "Reportes (.loors)",
    "canvas.ready": "Listo",
    "canvas.running": "Ejecutando",
    "canvas.autoScroll": "Auto",
    "canvas.consoleEmpty": "Pulsa Ejecutar para ver el pensamiento, streaming de tokens, tools y stdout/stderr en vivo.",
    "sidebar.searchNode": "Buscar nodo…",
    "sidebar.essentials": "Esenciales",
    "sidebar.contextResources": "Contexto y Recursos",
    "sidebar.advanced": "Avanzados e Integraciones",
    "sidebar.documents": "Documentos",
    "sidebar.customNodes": "Nodos Custom",
    "sidebar.create": "Crear",

    // Agent View
    "agent.newConversation": "Nueva conversación",
    "agent.projects": "Proyectos",
    "agent.addFirstProject": "Añadir primer proyecto…",
    "agent.noProject": "Sin proyecto",
    "agent.freeChat": "Conversación libre",
    "agent.newSession": "Nueva sesión",
    "agent.files": "Archivos",
    "agent.diff": "Diff",
    "agent.browser": "Navegador",
    "agent.filterFiles": "Filtrar archivos del proyecto…",
    "agent.pickProjectTree": "Elige un proyecto a la izquierda para ver su árbol de archivos.",
    "agent.liveBrowser": "Navegador en vivo",
    "agent.noBrowserSession": "Sin sesión de navegador activa",
    "agent.noBrowserDesc": "La vista en vivo se mostrará aquí cuando el agente navegue o interactúe con una página web.",
    "agent.heroTitle": "¿En qué trabajamos?",
    "agent.chooseOtherFolder": "+ Elegir otra carpeta…",
    "agent.composerPlaceholder": "Escribe un mensaje…",
    "agent.composerQueuePlaceholder": "Añade un mensaje a la cola…",
    "agent.chooseModel": "Elegir modelo…",
    "agent.searchModel": "Buscar modelo o cuantización…",
    "agent.noModelsYet": "No hay modelos descargados ni APIs activas todavía.",
    "agent.noLocalMatches": "Sin coincidencias en tus modelos locales.",
    "agent.localModelsBtn": "Modelos GGUF…",
    "agent.cloudApisBtn": "APIs / Cloud…",
    "agent.localPermissions": "Permisos locales",
    "agent.permReadOnly": "Solo lectura",
    "agent.permReadOnlyDesc": "Inspecciona y busca sin editar ni ejecutar comandos.",
    "agent.permAsk": "Preguntar",
    "agent.permAskDesc": "Pide aprobación antes de editar o ejecutar comandos.",
    "agent.permAuto": "Auto",
    "agent.permAutoDesc": "La IA evalúa si el comando es seguro; solo te pregunta si hay riesgo.",
    "agent.permTurbo": "Turbo",
    "agent.permTurboDesc": "Ejecuta ediciones y comandos directamente sin preguntar.",
    "agent.attachFiles": "Adjuntar archivos, PDFs o imágenes…",
    "agent.pinFile": "Fijar archivo del proyecto…",
    "agent.noPinMatches": "Sin archivos que coincidan en el proyecto.",

    // Onboarding
    "onboarding.title": "Configura un motor local o conecta un proveedor API para empezar.",
    "onboarding.optA": "Ejecución local",
    "onboarding.rtReady": "llama.cpp listo",
    "onboarding.rtInstalling": "Instalando llama.cpp…",
    "onboarding.rtInstallCta": "Instalar llama.cpp",
    "onboarding.rtInstallDesc": "Detección automática de GPU (CUDA, Vulkan, Metal o CPU)",
    "onboarding.rtInstalledPrefix": "Instalado",
    "onboarding.ggufCta": "Elegir o descargar un modelo GGUF",
    "onboarding.ggufDesc": "Explora Hugging Face o usa modelos locales existentes",
    "onboarding.ggufDetected": "modelo(s) disponible(s)",
    "onboarding.optB": "APIs en la nube y locales",
    "onboarding.cloudCta": "Conectar proveedor API",
    "onboarding.cloudDesc": "OpenAI, Anthropic, Gemini, LM Studio, Ollama o endpoints personalizados",

    // Suggestions
    "suggest.ws1": "Explora la arquitectura de este proyecto y resúmeme los archivos clave",
    "suggest.ws2": "Revisa los cambios recientes (git diff) y detecta posibles bugs",
    "suggest.ws3": "Busca mejoras de rendimiento o deuda técnica prioritaria",
    "suggest.free1": "Investiga un tema en internet y dame un resumen estructurado con fuentes",
    "suggest.free2": "Ayúdame a diseñar un script o arquitectura técnica paso a paso",
    "suggest.free3": "Analiza un archivo, PDF o captura que te adjunte aquí",

    // Models & AI Modal
    "models.title": "Modelos e IA",
    "models.tabLocal": "Descargados",
    "models.tabDiscover": "Explorar Hugging Face",
    "models.tabCloud": "APIs / Cloud",
    "models.rescan": "Reescanear",
    "models.searchLocal": "Buscar entre tus modelos locales (nombre, familia o cuantización Q4, Q8…)",
    "models.emptyLocal": "No hay archivos .gguf locales todavía",
    "models.emptyLocalDesc": "Loors detecta automáticamente modelos descargados en LM Studio y en su carpeta local, o puedes descargar cuantizaciones ahora desde Hugging Face.",
    "models.cloudHint": "Introduce tu API Key y pulsa Conectar y cargar modelos: Loors consulta automáticamente los modelos disponibles en cada proveedor.",
    "models.addCustom": "Añadir proveedor personalizado",
    "models.save": "Guardar",
    "models.saving": "Guardando…",
    "models.baseUrl": "URL base",
    "models.apiKey": "API Key (o ${ENV_VAR})",
    "models.connectLoad": "Conectar y cargar modelos",
    "models.refreshModels": "Actualizar modelos",
    "models.fetching": "Consultando API…",
    "models.filterModels": "Filtrar modelos…",
    "models.modelsCount": "modelos",
    "models.close": "Cerrar",

    // Architect Chat
    "architect.subtitle": "Diseñador de arneses .loors.json",
    "architect.placeholder": "Describe el arnés…",
    "architect.queuePlaceholder": "Escribe otro mensaje para encolarlo… (Enter para encolar)",
    "architect.emptyIntro": "Pídeme que diseñe un arnés desde cero o que mejore el arnés actual del lienzo. Puedes adjuntar archivos, carpetas o capturas.",
    "architect.p1": "Mejora este arnés y añade un nodo Refutador (Devil's Advocate) antes del Judge.",
    "architect.p2": "Crea un arnés TDD autónomo (Coder -> Tests -> Loop Guard -> Human Gate).",
    "architect.p3": "Crea un arnés conectado a Jira que lea un ticket, corrija el código y comente el resultado.",
    "architect.p4": "Revisa los prompts y tools de los agentes de mi arnés actual y optimízalos.",
    "architect.noModels": "No hay modelos locales ni APIs conectadas.",
    "architect.configModels": "Configurar modelos o APIs…",
    "architect.localGroup": "Modelos locales (GGUF)",
    "architect.readTools": "6 tools lectura",

    // Runtime Modal
    "runtime.title": "Runtime local (llama.cpp)",
    "runtime.backend": "Backend de inferencia",
    "runtime.auto": "Automático (recomendado)",
    "runtime.install": "Descargar / Actualizar llama.cpp",
    "runtime.done": "Listo",

    // Update Modal
    "updates.title": "Actualizaciones de Loors",
    "updates.installed": "Versión instalada",
    "updates.check": "Buscar actualizaciones",
    "updates.checking": "Comprobando…",
    "updates.repoLabel": "Repositorio GitHub Releases (usuario/repo)",
    "updates.upToDate": "Loors está actualizado",
    "updates.newAvailable": "Nueva versión disponible",
    "updates.viewRelease": "Ver release",
    "updates.downloadInstall": "Descargar e instalar",
    "updates.downloading": "Descargando actualización…",

    // Library Modal
    "library.title": "Biblioteca de Arneses (.loors.json)",
    "library.save": "Guardar en biblioteca",
    "library.export": "Exportar",
    "library.copyJson": "Copiar JSON",
    "library.import": "Importar",
    "library.localHeader": "BIBLIOTECA LOCAL DE ARNESES",
    "library.emptyLocal": "Aún no has guardado arneses en tu biblioteca local. También puedes arrastrar y soltar un archivo .loors.json directamente sobre el canvas.",
    "library.templatesHeader": "PLANTILLAS DE EJEMPLO",
    "library.use": "Usar",
    "library.pasteLabel": "Importar pegando JSON directamente",
    "library.importPasted": "Importar JSON pegado",
  },
} as const;

export type TranslationKey = keyof typeof TRANSLATIONS.en;

export function translate(locale: AppLocale, key: TranslationKey): string {
  return TRANSLATIONS[locale][key] ?? TRANSLATIONS.en[key] ?? key;
}

const NODE_LABELS_EN: Partial<Record<LoorsNodeKind, string>> = {
  data_transform: "Transform Data",
  create_excel: "Create Excel",
  create_csv: "Create CSV",
  create_word: "Create Word",
  create_pdf: "Create PDF",
  read_document: "Read Document",
  workspace: "Workspace / Project",
  subgraph: "Sub-harness (Subgraph)",
  local_model: "Model (GGUF / API)",
};

const NODE_DESCRIPTIONS_EN: Record<LoorsNodeKind, string> = {
  task_input: "Defines the initial task prompt and project workspace.",
  trigger: "Starts the harness via HTTP Webhook, Cron interval, or Telegram Bot.",
  workspace: "Pluggable project folder: connect to Agent/Shell/RAG or run inline to switch workspace.",
  local_model: "Selects the local GGUF model (llama.cpp) or Cloud API for connected agents and judges.",
  skill: "Loads a Markdown Skill (.md) to inject specialized instructions into an Agent.",
  mcp_server: "Connects an external MCP server (stdio) to expose extra tools to the Agent.",
  knowledge_rag: "Indexes project files and docs (PDF/DOCX/code) for fast BM25 semantic search.",
  agent: "Autonomous AI agent with file, shell, git, RAG, web search, and browser tools.",
  shell: "Runs a shell command, build, or test suite and branches on exit code.",
  http_request: "Calls external REST/JSON APIs (Jira, GitHub, Slack, webhooks) with template variables.",
  memory_file: "Reads, appends, or overwrites a persistent Markdown/JSON state file across loop iterations.",
  condition: "Branches execution based on exit code, output text match, or iteration count.",
  llm_judge: "Evaluates output quality with an AI rubric and routes to pass or fail.",
  loop_guard: "Controls maximum loop iterations and injects feedback back into the agent.",
  for_each: "Iterates over a JSON array or lines, emitting {{item}} to 'each' and finishing via 'done'.",
  json_validator: "Extracts and validates strict JSON and required keys, routing to 'valid' or 'invalid'.",
  data_transform: "Extracts a JSON value and selects or renames fields in an object or each element of an array.",
  create_excel: "Writes an array of JSON objects to an .xlsx workbook.",
  create_csv: "Writes an array of JSON objects to a comma-separated CSV file.",
  create_word: "Creates an editable .docx report with a title, sections, and tables.",
  create_pdf: "Creates a PDF report with a title, sections, and tables.",
  read_document: "Reads the contents of .docx, .xlsx, .pdf, and .csv files in the workspace.",
  git_checkpoint: "Creates a Git snapshot before edits or reverts changes on failure.",
  context_compactor: "Compresses long conversation history and logs to stay within context budget.",
  human_gate: "Pauses the harness so you can review the Git diff and approve or send feedback.",
  parallel_fanout: "Spawns isolated Git worktrees to run parallel branches concurrently.",
  swarm: "Synchronized multi-agent team with shared @mention message board, safe GPU/cloud concurrency, and optional Git worktrees.",
  subgraph: "Executes another saved .loors.json harness as a reusable step.",
  notify: "Sends notifications or reports to Telegram, Slack, Discord, or any webhook.",
  custom: "User-defined reusable Shell, HTTP, or Prompt node.",
  output: "Marks the final completion state and summarizes the harness run.",
};

const NODE_GUIDES: Record<LoorsNodeKind, { en: string; es: string }> = {
  task_input: {
    en: "Pick your project folder and write the initial task prompt, then connect 'exec' to the first step.",
    es: "Elige la carpeta del proyecto, escribe la tarea inicial y conecta 'exec' al primer paso.",
  },
  trigger: {
    en: "Choose Webhook, Cron interval, or Telegram Bot, then connect 'exec' to the first step to run automatically.",
    es: "Elige Webhook, Cron o Bot de Telegram y conecta 'exec' al primer paso para disparar el arnés automáticamente.",
  },
  workspace: {
    en: "Select a project folder and plug its 'workspace' port into Agent, Shell, or RAG nodes.",
    es: "Selecciona una carpeta de proyecto y enchufa su puerto 'workspace' en nodos Agent, Shell o RAG.",
  },
  local_model: {
    en: "Pick a local GGUF model or a connected Cloud API, then plug its 'model' port into Agent or LLM Judge nodes.",
    es: "Elige un GGUF local o una API Cloud conectada y enchufa su puerto 'model' en nodos Agent o LLM Judge.",
  },
  skill: {
    en: "Choose a Markdown skill (.md) and plug its 'skill' port into an Agent to inject specialized instructions.",
    es: "Elige una skill Markdown (.md) y enchufa 'skill' en un Agent para inyectarle instrucciones especializadas.",
  },
  mcp_server: {
    en: "Configure an MCP stdio command, test its tools, and plug 'mcp' into an Agent node.",
    es: "Configura un servidor MCP (stdio), prueba sus herramientas y enchufa 'mcp' en un nodo Agent.",
  },
  knowledge_rag: {
    en: "Plug 'knowledge' into an Agent (or run inline) to give it fast BM25 search over code and documents.",
    es: "Enchufa 'knowledge' en un Agent (o ejecútalo en línea) para darle búsqueda rápida BM25 sobre código y documentos.",
  },
  agent: {
    en: "Connect a Model node to 'model', write the System Prompt, pick allowed tools, and wire 'exec' to the next step.",
    es: "Conecta un nodo Model al puerto 'model', escribe el System Prompt, elige herramientas y conecta 'exec' al siguiente paso.",
  },
  shell: {
    en: "Enter a shell command (e.g. npm test, cargo test). Connect 'exec' to continue or 'stderr' / Condition to branch on failure.",
    es: "Escribe un comando (ej. npm test, cargo test). Conecta 'exec' para seguir o usa Condition para bifurcar si falla.",
  },
  http_request: {
    en: "Set method, URL, headers, and JSON body (supports {{variables}}). Use 'ok' for 2xx responses and 'error' for failures.",
    es: "Configura método, URL, headers y cuerpo JSON (admite {{variables}}). Usa 'ok' para respuestas 2xx y 'error' para fallos.",
  },
  memory_file: {
    en: "Pick Read, Append, or Write on a file inside .loors/ to persist state between loop iterations.",
    es: "Elige Leer, Añadir o Escribir sobre un archivo en .loors/ para guardar memoria entre iteraciones del bucle.",
  },
  condition: {
    en: "Set a rule (e.g. exit_code == 0 or contains:PASS), then wire 'true' for success and 'false' to retry or handle errors.",
    es: "Define una regla (ej. exit_code == 0 o contains:PASS) y conecta 'true' al éxito y 'false' para reintentar o manejar fallos.",
  },
  llm_judge: {
    en: "Connect a Model node to 'model', write your grading rubric, and wire 'pass' to finish or 'fail' to Loop Guard.",
    es: "Conecta un nodo Model a 'model', escribe la rúbrica de evaluación y conecta 'pass' al final o 'fail' a Loop Guard.",
  },
  loop_guard: {
    en: "Set max retries (0 = infinite), wire 'retry' BACK to your Agent's 'retry' port, and wire 'max_hit' to Output.",
    es: "Define el máximo de reintentos (0 = infinito), conecta 'retry' HACIA ATRÁS al puerto 'retry' del Agent y 'max_hit' a Output.",
  },
  for_each: {
    en: "Point Items source to a JSON array or lines (e.g. {{agent_output}}). Wire 'each' to your processing steps, loop back to this node's 'exec', and wire 'done' to finish.",
    es: "Apunta la fuente a un array JSON o líneas (ej. {{agent_output}}). Conecta 'each' a tus pasos, vuelve al 'exec' de este nodo y conecta 'done' al final.",
  },
  create_excel: {
    en: "Use a JSON array of objects. If you leave the columns blank, all keys are included in alphabetical order. The output value is the new file's workspace-relative path.",
    es: "Usa una lista JSON de objetos. Si dejas las columnas vacías, se incluyen todas las claves en orden alfabético. La salida es la ruta del archivo relativa al workspace.",
  },
  create_csv: {
    en: "Use a JSON array of objects. Columns are optional and default to all keys in alphabetical order. The CSV uses UTF-8 and commas. The output is the file path.",
    es: "Usa una lista JSON de objetos. Las columnas son opcionales y por defecto se incluyen todas las claves en orden alfabético. El CSV usa UTF-8 y comas. La salida es la ruta del archivo.",
  },
  create_word: {
    en: "Use a JSON report with title and sections. Sections can include a heading, paragraphs, and a table with headers and rows. The output is the file path.",
    es: "Usa un informe JSON con title y sections. Cada sección admite heading, paragraphs y una table con headers y rows. La salida es la ruta del archivo.",
  },
  create_pdf: {
    en: "Uses the same JSON structure as Create Word and prints it to PDF using an available Chromium-based browser. The output is the file path.",
    es: "Usa la misma estructura JSON que Crear Word y la imprime a PDF con un navegador Chromium disponible. La salida es la ruta del archivo.",
  },
  read_document: {
    en: "Enter a workspace-relative path or insert the output of a creation node. The output is extracted text. Scanned PDFs require a text layer.",
    es: "Escribe una ruta relativa al workspace o inserta la salida de un nodo de creación. La salida es texto extraído. Los PDF escaneados requieren una capa de texto.",
  },
  data_transform: {
    en: "Use JSON Pointer paths such as /results or /metadata/title. Leave the root path blank to use the entire input. Field paths are relative to the selected value or each array element. Use the node's output variable to pass the result to For Each.",
    es: "Usa rutas JSON Pointer como /results o /metadata/title. Deja la ruta raíz vacía para usar la entrada completa. Las rutas de los campos parten del valor seleccionado o de cada elemento de la lista. Usa la variable de salida del nodo para pasar el resultado a For Each.",
  },
  json_validator: {
    en: "Set expected JSON type and comma-separated required keys. Wire 'valid' to continue and 'invalid' to a Loop Guard for automatic repair.",
    es: "Define el tipo JSON esperado y las claves obligatorias separadas por comas. Conecta 'valid' para seguir e 'invalid' a un Loop Guard para auto-reparación.",
  },
  git_checkpoint: {
    en: "Choose 'diff' to inspect changes, 'snapshot' to save a commit before edits, or 'revert' to roll back on failure.",
    es: "Elige 'diff' para inspeccionar cambios, 'snapshot' para guardar estado o 'revert' para deshacer cambios si falla.",
  },
  context_compactor: {
    en: "Place inside long loops to trim old stdout/stderr and keep prompts within your model's context window.",
    es: "Colócalo dentro de bucles largos para recortar logs antiguos y evitar desbordar el contexto del modelo.",
  },
  human_gate: {
    en: "Place before sensitive steps: pauses execution to show you the Git diff and routes to 'approve' or 'reject'.",
    es: "Colócalo antes de pasos críticos: pausa la ejecución para revisar el Git diff y enruta a 'approve' o 'reject'.",
  },
  parallel_fanout: {
    en: "Define parallel branch tasks; Loors creates isolated Git worktrees and merges results on completion.",
    es: "Define tareas paralelas; Loors crea worktrees Git aislados para cada rama y recoge los resultados al terminar.",
  },
  swarm: {
    en: "Connect a model to 'model', configure your specialist workers (or pick a preset), and watch them collaborate via @mentions in the Console Swarm tab.",
    es: "Conecta un modelo al puerto 'model', configura tus workers especialistas (o elige un preset) y sigue su colaboración con @menciones en la pestaña Swarm.",
  },
  subgraph: {
    en: "Pick another saved .loors.json harness from your library to run it as a modular step.",
    es: "Elige otro arnés .loors.json guardado en tu biblioteca para ejecutarlo como un paso modular.",
  },
  notify: {
    en: "Configure Telegram, Slack, Discord, or Webhook and write the message template (supports {{agent_output}}, {{stdout}}).",
    es: "Configura Telegram, Slack, Discord o Webhook y escribe la plantilla del mensaje (admite {{agent_output}}, {{stdout}}).",
  },
  custom: {
    en: "Fill in this custom node's parameters and connect 'ok' / 'error' to the rest of your harness.",
    es: "Rellena los parámetros de este nodo personalizado y conecta 'ok' / 'error' al resto del arnés.",
  },
  output: {
    en: "Terminal node: connect your final 'exec' / 'pass' / 'true' edge here to finish the run cleanly.",
    es: "Nodo final: conecta aquí tu cable final ('exec', 'pass' o 'true') para cerrar la ejecución limpiamente.",
  },
};

export function getNodeGuide(kind: LoorsNodeKind, locale: AppLocale): string {
  const entry = NODE_GUIDES[kind];
  if (!entry) return "";
  return locale === "es" ? entry.es : entry.en;
}

export function getNodeLabel(kind: LoorsNodeKind, locale: AppLocale): string {
  if (locale === "en" && NODE_LABELS_EN[kind]) {
    return NODE_LABELS_EN[kind]!;
  }
  return NODE_BLUEPRINTS[kind]?.label ?? kind;
}

export function getNodeDescription(kind: LoorsNodeKind, locale: AppLocale): string {
  if (locale === "en") {
    return NODE_DESCRIPTIONS_EN[kind] ?? NODE_BLUEPRINTS[kind]?.description ?? "";
  }
  return NODE_BLUEPRINTS[kind]?.description ?? "";
}

export function useI18n() {
  const locale = useGraphStore((s) => s.locale);
  const setLocale = useGraphStore((s) => s.setLocale);
  const t = (key: TranslationKey) => translate(locale, key);
  return { locale, setLocale, t };
}
