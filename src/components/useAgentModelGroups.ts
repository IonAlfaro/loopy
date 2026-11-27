import { useMemo } from "react";
import { parseGgufMetadata, type LocalModelFile } from "../types/graph";

export function useAgentModelGroups(localModels: LocalModelFile[], modelPickerQuery: string) {
  return useMemo(() => {
    const q = modelPickerQuery.trim().toLowerCase();
    const groups = new Map<
      string,
      {
        baseName: string;
        family: string;
        params: string | null;
        items: { file: LocalModelFile; meta: ReturnType<typeof parseGgufMetadata> }[];
      }
    >();
    for (const file of localModels) {
      const meta = parseGgufMetadata(file.path, file.size_mb * 1024 * 1024);
      if (
        q &&
        !file.name.toLowerCase().includes(q) &&
        !meta.baseName.toLowerCase().includes(q) &&
        !meta.quant.toLowerCase().includes(q) &&
        !meta.family.toLowerCase().includes(q)
      ) {
        continue;
      }
      const key = `${meta.family}::${meta.baseName}`;
      const existing = groups.get(key);
      if (existing) existing.items.push({ file, meta });
      else {
        groups.set(key, {
          baseName: meta.baseName,
          family: meta.family,
          params: meta.params,
          items: [{ file, meta }],
        });
      }
    }
    return Array.from(groups.values());
  }, [localModels, modelPickerQuery]);
}
