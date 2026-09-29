"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { ArtifactFile, ArtifactKind } from "@/lib/renderer";

export type ImportStaging = {
  suggestedTitle: string | null;
  kind: ArtifactKind;
  files: ArtifactFile[];
  entry: string | null;
  notice: string | null;
};

type StagingContext = {
  staging: ImportStaging | null;
  setStaging: (staging: ImportStaging) => void;
  clearStaging: () => void;
};

const Ctx = createContext<StagingContext | null>(null);

export function ImportStagingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [staging, setStagingState] = useState<ImportStaging | null>(null);

  const setStaging = useCallback((next: ImportStaging) => {
    setStagingState(next);
  }, []);
  const clearStaging = useCallback(() => {
    setStagingState(null);
  }, []);

  const value = useMemo(
    () => ({ staging, setStaging, clearStaging }),
    [staging, setStaging, clearStaging],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useImportStaging(): StagingContext {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error(
      "useImportStaging must be used inside <ImportStagingProvider>",
    );
  }
  return ctx;
}
