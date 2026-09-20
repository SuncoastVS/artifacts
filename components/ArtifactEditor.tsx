"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  FilePlus2,
  Upload,
  Save,
  Eye,
  Code2,
  Sparkles,
  FileCode2,
  Globe2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ArtifactRenderer } from "@/components/ArtifactRenderer";
import { FileList as ArtifactFileList } from "@/components/FileList";
import { cn } from "@/lib/utils";
import {
  buildArtifactDocument,
  inferKind,
  type ArtifactFile,
  type ArtifactKind,
} from "@/lib/renderer";
import { saveArtifact } from "@/lib/save-artifact";
import { MIN_DESCRIPTION_CHARS } from "@/lib/validation";

type NewInitial = {
  title?: string;
  description?: string | null;
  kind?: ArtifactKind;
  files?: ArtifactFile[];
  entry?: string | null;
  inDirectory?: boolean;
};

type EditInitial = {
  id: string;
  title: string;
  description: string | null;
  kind: ArtifactKind;
  files: ArtifactFile[];
  entry: string | null;
  inDirectory: boolean;
};

type Props =
  | { mode: "new"; initial?: NewInitial }
  | { mode: "edit"; initial: EditInitial };

const ACCEPTED =
  ".html,.htm,.css,.js,.mjs,.jsx,.ts,.tsx,.json,.png,.jpg,.jpeg,.gif,.webp,.avif,.svg,.ico,.bmp";
const BINARY_RE = /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i;

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}

const STARTER_HTML: ArtifactFile = {
  name: "index.html",
  type: "text/html",
  content: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Hello</title>
<link rel="stylesheet" href="style.css" />
</head>
<body>
<div class="hero">
  <h1>Hello, world.</h1>
  <p>Edit the files on the left and watch the preview update.</p>
  <button id="cta">Click me</button>
</div>
<script src="app.js"></script>
</body>
</html>`,
};
const STARTER_CSS: ArtifactFile = {
  name: "style.css",
  type: "text/css",
  content: `* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, sans-serif;
  background: linear-gradient(180deg, #fafafa, #efefef);
  min-height: 100vh;
  display: grid;
  place-items: center;
  color: #1a1a1a;
}
.hero { text-align: center; padding: 2rem; }
h1 { font-size: clamp(2rem, 6vw, 4rem); margin: 0 0 0.5rem; }
p { color: #555; margin: 0 0 1.5rem; }
button {
  padding: 0.6rem 1.2rem;
  border-radius: 9999px;
  border: 0;
  background: #111;
  color: white;
  font-weight: 600;
  cursor: pointer;
}
button:hover { background: #333; }
`,
};
const STARTER_JS: ArtifactFile = {
  name: "app.js",
  type: "text/javascript",
  content: `document.getElementById('cta').addEventListener('click', () => {
  alert('Hello from your artifact!');
});`,
};

const STARTER_JSX: ArtifactFile = {
  name: "App.jsx",
  type: "text/jsx",
  content: `function App() {
  const [count, setCount] = React.useState(0);
  return (
    <div style={{
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      background: 'linear-gradient(180deg,#fafafa,#efefef)',
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: '3rem', margin: 0 }}>Counter</h1>
        <p style={{ color: '#555' }}>You clicked {count} times.</p>
        <button
          onClick={() => setCount(c => c + 1)}
          style={{
            padding: '0.6rem 1.2rem',
            borderRadius: 9999,
            border: 0,
            background: '#111',
            color: 'white',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Add one
        </button>
      </div>
    </div>
  );
}`,
};

function detectType(name: string): string {
  if (/\.html?$/i.test(name)) return "text/html";
  if (/\.css$/i.test(name)) return "text/css";
  if (/\.m?js$/i.test(name)) return "text/javascript";
  if (/\.tsx?$/i.test(name)) return "text/typescript";
  if (/\.jsx$/i.test(name)) return "text/jsx";
  if (/\.json$/i.test(name)) return "application/json";
  if (/\.svg$/i.test(name)) return "image/svg+xml";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.gif$/i.test(name)) return "image/gif";
  if (/\.webp$/i.test(name)) return "image/webp";
  if (/\.avif$/i.test(name)) return "image/avif";
  if (/\.ico$/i.test(name)) return "image/x-icon";
  if (/\.bmp$/i.test(name)) return "image/bmp";
  return "text/plain";
}

export function ArtifactEditor(props: Props) {
  const { mode } = props;
  const initial = props.initial;
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [inDirectory, setInDirectory] = useState(initial?.inDirectory ?? false);
  const [files, setFiles] = useState<ArtifactFile[]>(
    initial?.files ?? [STARTER_HTML, STARTER_CSS, STARTER_JS],
  );
  const [activeName, setActiveName] = useState<string>(
    initial?.files?.[0]?.name ?? STARTER_HTML.name,
  );
  const [entry, setEntry] = useState<string | null>(initial?.entry ?? null);
  const [tab, setTab] = useState<"code" | "preview" | "split">("split");
  const [dragOver, setDragOver] = useState(false);
  const [pending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const kind: ArtifactKind = useMemo(
    () => (initial?.kind ?? inferKind(files)),
    [initial?.kind, files],
  );

  const activeFile = useMemo(
    () => files.find((f) => f.name === activeName) ?? files[0],
    [files, activeName],
  );

  const previewDoc = useMemo(
    () => buildArtifactDocument({ kind, files, entry }),
    [kind, files, entry],
  );

  const addOrReplaceFile = useCallback((file: ArtifactFile) => {
    setFiles((prev) => {
      const idx = prev.findIndex((f) => f.name === file.name);
      if (idx >= 0) {
        const copy = prev.slice();
        copy[idx] = file;
        return copy;
      }
      return [...prev, file];
    });
    setActiveName(file.name);
  }, []);

  const handleFiles = useCallback(
    async (list: FileList | File[]) => {
      const items = Array.from(list);
      for (const f of items) {
        if (BINARY_RE.test(f.name)) {
          const content = await fileToBase64(f);
          addOrReplaceFile({
            name: f.name,
            type: f.type || detectType(f.name),
            content,
            encoding: "base64",
          });
        } else {
          const content = await f.text();
          addOrReplaceFile({
            name: f.name,
            type: f.type || detectType(f.name),
            content,
            encoding: "utf8",
          });
        }
      }
    },
    [addOrReplaceFile],
  );

  const onPaste = (e: React.ClipboardEvent) => {
    // No-op: pasting into textarea is handled natively.
    e.stopPropagation();
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles],
  );

  const removeFile = (name: string) => {
    const next = files.filter((f) => f.name !== name);
    const fallback = [STARTER_HTML, STARTER_CSS, STARTER_JS];

    setFiles(next.length ? next : fallback);
    if (activeName === name) {
      setActiveName(next[0]?.name ?? STARTER_HTML.name);
    }
    if (entry === name) {
      setEntry(null);
    }
  };

  const insertStarterJsx = () => {
    addOrReplaceFile(STARTER_JSX);
    setEntry(STARTER_JSX.name);
  };

  const insertNewFile = () => {
    const base = "untitled";
    const ext = kind === "jsx" ? ".jsx" : ".html";
    let n = 1;
    while (files.some((f) => f.name === `${base}-${n}${ext}`)) n++;
    const name = `${base}-${n}${ext}`;
    addOrReplaceFile({
      name,
      type: detectType(name),
      content: "",
    });
  };

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const titleMissing =
    trimmedTitle === "" || (mode === "new" && trimmedTitle === "Untitled");
  const descriptionInvalid =
    trimmedDescription.length < MIN_DESCRIPTION_CHARS;
  const saveDisabled = pending || titleMissing || descriptionInvalid;

  const validationHint = titleMissing
    ? "Set a title before saving."
    : descriptionInvalid
      ? trimmedDescription.length === 0
        ? "Add a description before saving."
        : `Description must be at least ${MIN_DESCRIPTION_CHARS} characters.`
      : null;

  const onSave = () => {
    setErrorMsg(null);
    if (titleMissing || descriptionInvalid) return;
    startTransition(async () => {
      const res = await saveArtifact(
        { title, description, kind, files, entry, inDirectory },
        props.mode === "edit" ? props.initial.id : undefined,
      );
      if ("error" in res && res.error) {
        setErrorMsg(res.error);
        return;
      }
      if ("id" in res && res.id) {
        router.push(`/a/${res.id}`);
      } else {
        router.refresh();
      }
    });
  };

  const segBtn = (selected: boolean) =>
    cn(
      "flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors",
      selected
        ? "bg-gradient-to-b from-sea to-sea-deep text-shell-bright shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
        : "text-ink-mute hover:bg-shell-deep hover:text-ink",
    );

  return (
    <div
      className="flex h-full flex-col bg-shell"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="border-b border-sea/15 bg-shell/95 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
                className="h-9 max-w-md rounded-lg border-0 bg-shell-deep/55 text-base font-bold focus-visible:ring-1"
              />
              <span className="hidden whitespace-nowrap code-font text-xs text-ink-mute sm:inline">
                {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
                {kind === "jsx" ? "React" : "HTML"}
              </span>
            </div>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (required, min 10 chars) — shown on the dashboard and in the SVS Directory"
              aria-required
              className={cn(
                "h-8 max-w-2xl rounded-lg border-0 bg-shell-deep/35 text-xs focus-visible:ring-1",
                trimmedDescription.length > 0 &&
                  descriptionInvalid &&
                  "ring-1 ring-destructive/40",
              )}
            />
          </div>

          <div className="flex items-center gap-1 rounded-full border border-sea/25 bg-shell-bright p-0.5">
            <button
              type="button"
              onClick={() => setTab("code")}
              aria-pressed={tab === "code"}
              className={segBtn(tab === "code")}
            >
              <Code2 className="h-3.5 w-3.5" />
              Code
            </button>
            <button
              type="button"
              onClick={() => setTab("split")}
              aria-pressed={tab === "split"}
              className={segBtn(tab === "split")}
            >
              Split
            </button>
            <button
              type="button"
              onClick={() => setTab("preview")}
              aria-pressed={tab === "preview"}
              className={segBtn(tab === "preview")}
            >
              <Eye className="h-3.5 w-3.5" />
              Preview
            </button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {errorMsg && (
              <span className="max-w-64 truncate text-xs font-medium text-destructive">
                {errorMsg}
              </span>
            )}
            {!errorMsg && validationHint && (
              <span className="hidden max-w-64 truncate text-xs text-ink-mute sm:inline">
                {validationHint}
              </span>
            )}
            <button
              type="button"
              onClick={() => setInDirectory((v) => !v)}
              aria-pressed={inDirectory}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors",
                inDirectory
                  ? "border-amber/60 bg-sand/35 text-amber-deep"
                  : "border-sea/25 bg-shell-bright text-ink-mute hover:bg-shell-deep hover:text-ink",
              )}
            >
              <Globe2 className="h-3.5 w-3.5" />
              {inDirectory ? "In SVS Directory" : "Share to SVS Directory"}
            </button>
            <label className="cursor-pointer">
              <input
                type="file"
                multiple
                accept={ACCEPTED}
                hidden
                onChange={(e) => {
                  if (e.target.files) handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-sea/25 bg-shell-bright px-3 text-xs font-semibold text-ink-soft transition-colors hover:bg-shell-deep">
                <Upload className="h-3.5 w-3.5" />
                Upload
              </span>
            </label>
            <Button
              size="sm"
              variant="outline"
              onClick={insertStarterJsx}
              className="hidden sm:inline-flex"
            >
              <Sparkles className="h-3.5 w-3.5" />
              JSX starter
            </Button>
            <Button
              size="sm"
              onClick={onSave}
              disabled={saveDisabled}
              title={validationHint ?? undefined}
            >
              <Save className="h-3.5 w-3.5" />
              {pending ? "Saving..." : mode === "new" ? "Save" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>

      <div className="border-b border-sea/12 bg-shell-deep/40 md:hidden">
        <div className="scroll-thin flex items-center gap-2 overflow-x-auto px-3 py-2">
          {files.map((file) => (
            <button
              type="button"
              key={file.name}
              onClick={() => setActiveName(file.name)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
                activeName === file.name
                  ? "border-amber/60 bg-sand/30 text-amber-deep"
                  : "border-sea/20 bg-shell-bright text-ink-mute",
              )}
            >
              <FileCode2 className="h-3.5 w-3.5" />
              <span className="code-font max-w-32 truncate">{file.name}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={insertNewFile}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-sea/20 bg-shell-bright px-3 text-xs text-ink-mute"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            New file
          </button>
        </div>
      </div>

      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[16rem_minmax(0,1fr)_minmax(0,1fr)]",
          tab === "split"
            ? "grid-rows-[minmax(0,1fr)_minmax(0,1fr)] md:grid-rows-none"
            : "grid-rows-[minmax(0,1fr)]",
        )}
      >
        <aside className="hidden border-r border-sea/12 bg-shell-deep/40 md:flex md:flex-col">
          <div className="mono-label flex items-center justify-between border-b border-sea/12 px-3 py-2.5">
            Files
            <button
              type="button"
              onClick={insertNewFile}
              className="rounded-full p-1 text-ink-mute transition-colors hover:bg-shell-deep hover:text-sea-deep"
              aria-label="New file"
            >
              <FilePlus2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="scroll-thin flex-1 overflow-auto">
            <ArtifactFileList
              files={files}
              entry={entry}
              activeName={activeName}
              onSelect={setActiveName}
              onRemove={removeFile}
              onSetEntry={(name) => setEntry(name)}
            />
          </div>
          <p className="border-t border-sea/12 px-3 py-2 text-[11px] leading-snug text-ink-mute">
            Drag files anywhere. Set an entry file to control the first run.
          </p>
        </aside>

        <section
          className={cn(
            "flex min-h-0 flex-col border-r border-sea/12 bg-shell-bright",
            tab === "preview" && "hidden",
            tab === "code" && "md:col-span-2",
          )}
        >
          <div className="flex h-9 items-center gap-2 border-b border-sea/12 bg-shell-deep/50 px-3 text-xs">
            <FileCode2 className="h-3.5 w-3.5 text-sea" />
            <span className="code-font truncate text-ink">
              {activeFile?.name ?? "No file"}
            </span>
            {activeFile && (
              <button
                type="button"
                onClick={() => setEntry(activeFile.name)}
                className={cn(
                  "ml-auto rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors",
                  entry === activeFile.name
                    ? "border-amber/60 bg-sand/35 text-amber-deep"
                    : "border-sea/25 bg-shell-bright text-ink-mute hover:text-ink",
                )}
              >
                {entry === activeFile.name ? "Entry file" : "Set as entry"}
              </button>
            )}
          </div>
          <Textarea
            value={activeFile?.content ?? ""}
            onChange={(e) =>
              setFiles((prev) =>
                prev.map((f) =>
                  f.name === activeFile?.name
                    ? { ...f, content: e.target.value }
                    : f,
                ),
              )
            }
            onPaste={onPaste}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded-none border-0 bg-abyss px-4 py-3 text-[13px] leading-6 text-shell caret-sand shadow-none placeholder:text-shell/35 focus-visible:ring-0"
            placeholder="// Paste or type your code here"
          />
        </section>

        <section
          className={cn(
            "relative flex min-h-0 flex-col bg-white",
            tab === "code" && "hidden",
            tab === "preview" && "md:col-span-2",
          )}
        >
          <div className="flex h-9 items-center justify-between border-b border-sea/12 bg-shell-bright px-3 text-xs text-ink-mute">
            <span className="flex items-center gap-2">
              <Eye className="h-3.5 w-3.5 text-sea" />
              Preview
            </span>
            <span className="mono-label hidden sm:inline">Sandboxed iframe</span>
          </div>
          <div className="relative min-h-0 flex-1">
            <ArtifactRenderer doc={previewDoc} />
            {dragOver && (
              <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-amber bg-sand/25 text-sm font-bold text-amber-deep">
                Drop files to add them to this artifact
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
