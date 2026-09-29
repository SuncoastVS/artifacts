"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useImportStaging } from "@/components/ImportStagingProvider";
import {
  inferKind,
  type ArtifactFile,
  type ArtifactKind,
} from "@/lib/renderer";
import {
  SUPPORTED_FILE_RE,
  describeResized,
  readArtifactFile,
  type ResizedImage,
} from "@/lib/file-ingest";

const MAX_FILES = 80;

const baseName = (path: string) => path.split("/").pop() ?? path;
const isRoot = (path: string) => !path.includes("/");

function suggestImportTitle(
  rootName: string | null,
  files: ArtifactFile[],
): string | null {
  const trimmedRoot = rootName?.trim();
  if (trimmedRoot && trimmedRoot !== "Untitled") return trimmedRoot;

  if (files.length === 1) {
    const name = baseName(files[0].name).replace(/\.[^.]+$/, "").trim();
    if (name && name !== "Untitled") return name;
  }

  return null;
}

function readDir(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryToFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(
  entry: FileSystemEntry,
  prefix: string,
): Promise<Array<{ path: string; file: File }>> {
  if (entry.isFile) {
    const file = await entryToFile(entry as FileSystemFileEntry);
    return [{ path: prefix + entry.name, file }];
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const all: FileSystemEntry[] = [];
    // readEntries returns at most ~100 per call — loop until empty.
    while (true) {
      const batch = await readDir(reader);
      if (!batch.length) break;
      all.push(...batch);
    }
    const out: Array<{ path: string; file: File }> = [];
    const next = `${prefix}${entry.name}/`;
    for (const child of all) {
      out.push(...(await walk(child, next)));
    }
    return out;
  }
  return [];
}

async function collectDropped(dt: DataTransfer): Promise<{
  files: Array<{ path: string; file: File }>;
  rootName: string | null;
}> {
  // DataTransfer goes stale the moment we await, so snapshot everything
  // we'll need from it (entries AND files) synchronously up front.
  const items = Array.from(dt.items).filter((i) => i.kind === "file");
  const entries: FileSystemEntry[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  const fallbackFiles = Array.from(dt.files);

  if (entries.length) {
    const collected: Array<{ path: string; file: File }> = [];
    for (const entry of entries) {
      collected.push(...(await walk(entry, "")));
    }

    const onlyDir =
      entries.length === 1 && entries[0].isDirectory
        ? (entries[0] as FileSystemDirectoryEntry)
        : null;
    if (onlyDir) {
      const prefix = `${onlyDir.name}/`;
      for (const c of collected) {
        if (c.path.startsWith(prefix)) c.path = c.path.slice(prefix.length);
      }
      return { files: collected, rootName: onlyDir.name };
    }
    return { files: collected, rootName: null };
  }

  return {
    files: fallbackFiles.map((file) => ({ path: file.name, file })),
    rootName: null,
  };
}

function pickEntry(
  files: ArtifactFile[],
  kind: ArtifactKind,
):
  | { ambiguous: false; entry: string | null }
  | { ambiguous: true; candidates: ArtifactFile[] } {
  const isCandidate =
    kind === "jsx"
      ? (n: string) => /\.(jsx|tsx)$/i.test(n)
      : (n: string) => /\.html?$/i.test(n);
  const isCanonical =
    kind === "jsx"
      ? (n: string) => /^(App|Main|index|Page)\.(jsx|tsx)$/i.test(baseName(n))
      : (n: string) => /^index\.html?$/i.test(baseName(n));

  const candidates = files.filter((f) => isCandidate(f.name));
  if (candidates.length === 0) return { ambiguous: false, entry: null };
  if (candidates.length === 1)
    return { ambiguous: false, entry: candidates[0].name };

  const rootCanonical = candidates.filter(
    (f) => isRoot(f.name) && isCanonical(f.name),
  );
  if (rootCanonical.length === 1)
    return { ambiguous: false, entry: rootCanonical[0].name };

  const rootOnly = candidates.filter((f) => isRoot(f.name));
  if (rootOnly.length === 1)
    return { ambiguous: false, entry: rootOnly[0].name };

  return { ambiguous: true, candidates };
}

export type Pending = {
  suggestedTitle: string | null;
  kind: ArtifactKind;
  files: ArtifactFile[];
  candidates: ArtifactFile[];
  notice: string | null;
};

export function useFolderImport() {
  const router = useRouter();
  const { setStaging } = useImportStaging();
  const counter = useRef(0);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files");

  const stageAndGo = useCallback(
    (
      suggestedTitle: string | null,
      kind: ArtifactKind,
      files: ArtifactFile[],
      entry: string | null,
      notice: string | null,
    ) => {
      setStaging({ suggestedTitle, kind, files, entry, notice });
      setPending(null);
      setBusy(false);
      router.push("/new");
    },
    [router, setStaging],
  );

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    counter.current += 1;
    setHover(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    counter.current -= 1;
    if (counter.current <= 0) {
      counter.current = 0;
      setHover(false);
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      counter.current = 0;
      setHover(false);
      setError(null);
      setBusy(true);
      try {
        const { files, rootName } = await collectDropped(e.dataTransfer);
        const supported = files.filter(({ path }) => SUPPORTED_FILE_RE.test(path));
        const skipped = files.filter(({ path }) => !SUPPORTED_FILE_RE.test(path));
        if (!supported.length) {
          setError(
            "No supported files found. Try HTML, CSS, JS, JSX, TS, TSX, images, or fonts.",
          );
          return;
        }
        if (supported.length > MAX_FILES) {
          setError(
            `That's ${supported.length} files. Cap is ${MAX_FILES} per artifact.`,
          );
          return;
        }
        if (skipped.length) {
          console.warn(
            `Skipped ${skipped.length} unsupported file(s):`,
            skipped.map((s) => s.path),
          );
        }

        const artifactFiles: ArtifactFile[] = [];
        const resized: ResizedImage[] = [];
        for (const { path, file } of supported) {
          const read = await readArtifactFile(file, path);
          artifactFiles.push(read.file);
          if (read.resized) resized.push(read.resized);
        }

        const suggestedTitle = suggestImportTitle(rootName, artifactFiles);
        const kind = inferKind(artifactFiles);
        const decision = pickEntry(artifactFiles, kind);
        const notice = describeResized(resized);

        if (decision.ambiguous) {
          setPending({
            suggestedTitle,
            kind,
            files: artifactFiles,
            candidates: decision.candidates,
            notice,
          });
          setBusy(false);
          return;
        }

        stageAndGo(suggestedTitle, kind, artifactFiles, decision.entry, notice);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't read those files.");
        setBusy(false);
      }
    },
    [stageAndGo],
  );

  const confirmEntry = useCallback(
    (entry: string | null) => {
      if (!pending) return;
      stageAndGo(
        pending.suggestedTitle,
        pending.kind,
        pending.files,
        entry,
        pending.notice,
      );
    },
    [pending, stageAndGo],
  );

  const cancelPending = useCallback(() => {
    setPending(null);
    setError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    hover,
    busy,
    pending,
    error,
    dragProps: { onDragEnter, onDragLeave, onDragOver, onDrop },
    confirmEntry,
    cancelPending,
    clearError,
  };
}
