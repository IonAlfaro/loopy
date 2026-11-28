import { useI18n } from "../i18n";
import type { AgentLimits } from "../types/graph";

const fields = [
  { key: "iterations", min: 1, max: 200, fallback: 40, label: ["Iteraciones del agente", "Agent iterations"],
    help: ["Rondas en las que el agente decide qué hacer a continuación.", "Rounds in which the agent decides what to do next."] },
  { key: "totalInferences", min: 1, max: 1000, fallback: 100, label: ["Llamadas totales al modelo", "Total model calls"],
    help: ["Incluye al agente, a los subagentes y la revisión automática.", "Includes the agent, subagents, and automatic review."] },
  { key: "recoveryAttempts", min: 0, max: 10, fallback: 2, label: ["Intentos de recuperación", "Recovery attempts"],
    help: ["Veces que el agente puede replantear su estrategia antes de pausar. Usa 0 para desactivarlo.", "Times the agent can change strategy before pausing. Set to 0 to disable."] },
  { key: "identicalResults", min: 2, max: 20, fallback: 4, label: ["Resultados idénticos", "Identical results"],
    help: ["Repeticiones de una misma llamada y resultado antes de activar la recuperación.", "Repeats of the same tool call and result before recovery is triggered."] },
  { key: "reviewAttempts", min: 1, max: 10, fallback: 3, label: ["Revisiones por tarea", "Reviews per task"],
    help: ["Máximo de intentos de revisión independiente por tarea del plan.", "Maximum independent review attempts per plan task."] },
  { key: "verifierSteps", min: 1, max: 20, fallback: 6, label: ["Pasos por revisión", "Steps per review"],
    help: ["Máximo de pasos del verificador en cada intento.", "Maximum verifier steps in each attempt."] },
] as const;

type Props = {
  limits?: AgentLimits;
  disabled: boolean;
  onSave: (limits?: AgentLimits) => void;
};

export function AgentLimitSettings({ limits, disabled, onSave }: Props) {
  const { locale } = useI18n();
  const language = locale === "es" ? 0 : 1;

  return (
    <details className="context-skills agent-limit-settings">
      <summary>{locale === "es" ? "Límites del agente" : "Agent limits"}</summary>
      <p className="context-hint">
        {locale === "es"
          ? "Se aplican a partir del siguiente turno. Deja un campo vacío para usar el ajuste del entorno o su valor predeterminado."
          : "Applies starting with the next turn. Leave a field blank to use its environment setting or built-in default."}
      </p>
      <form
        key={fields.map(({ key }) => limits?.[key] ?? "").join(",")}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const next: AgentLimits = {};
          for (const { key, min, max } of fields) {
            const value = data.get(key);
            if (typeof value !== "string" || value === "") continue;
            const number = Number(value);
            if (!Number.isInteger(number) || number < min || number > max) return;
            next[key] = number;
          }
          onSave(Object.keys(next).length ? next : undefined);
        }}
        onReset={() => onSave(undefined)}
      >
        <fieldset disabled={disabled}>
          {fields.map(({ key, min, max, fallback, label, help }) => (
            <label key={key}>
              <span>{label[language]}<small className="context-hint">{help[language]}</small></span>
              <input name={key} type="number" min={min} max={max} step={1}
                defaultValue={limits?.[key]} placeholder={String(fallback)}
                title={`${min}–${max}`} />
            </label>
          ))}
          <div className="agent-limit-actions">
            <button type="reset" className="btn-secondary btn-xs">{locale === "es" ? "Restaurar valores" : "Reset to defaults"}</button>
            <button type="submit" className="btn-secondary btn-xs">{locale === "es" ? "Guardar límites" : "Save limits"}</button>
          </div>
        </fieldset>
      </form>
    </details>
  );
}
