import type { ArtifactFile } from "@/lib/renderer";

const EXTENSIONS = [
  "html", "htm", "css", "js", "mjs", "jsx", "ts", "tsx", "json",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp",
  "woff2", "woff", "ttf", "otf",
];

export const SUPPORTED_FILE_RE = new RegExp(`\\.(${EXTENSIONS.join("|")})$`, "i");
export const ACCEPTED_FILE_TYPES = EXTENSIONS.map((ext) => `.${ext}`).join(",");

const BINARY_RE = /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf)$/i;
// Formats every browser canvas can re-encode without losing animation.
const RESIZABLE_RE = /\.(jpe?g|png|webp)$/i;

// Camera photos (4000px+) are the usual reason an artifact exceeds the upload
// limit. 2048px still covers a full-width image on a 1024px retina viewport.
export const MAX_IMAGE_DIMENSION = 2048;
const JPEG_WEBP_QUALITY = 0.85;

const TYPES: Array<[RegExp, string]> = [
  [/\.html?$/i, "text/html"],
  [/\.css$/i, "text/css"],
  [/\.m?js$/i, "text/javascript"],
  [/\.tsx?$/i, "text/typescript"],
  [/\.jsx$/i, "text/jsx"],
  [/\.json$/i, "application/json"],
  [/\.svg$/i, "image/svg+xml"],
  [/\.png$/i, "image/png"],
  [/\.jpe?g$/i, "image/jpeg"],
  [/\.gif$/i, "image/gif"],
  [/\.webp$/i, "image/webp"],
  [/\.avif$/i, "image/avif"],
  [/\.ico$/i, "image/x-icon"],
  [/\.bmp$/i, "image/bmp"],
  [/\.woff2$/i, "font/woff2"],
  [/\.woff$/i, "font/woff"],
  [/\.ttf$/i, "font/ttf"],
  [/\.otf$/i, "font/otf"],
];

export function detectType(name: string): string {
  return TYPES.find(([re]) => re.test(name))?.[1] ?? "text/plain";
}

type Size = { width: number; height: number };

export type ResizedImage = { name: string; from: Size; to: Size };

export function fitWithin(
  width: number,
  height: number,
  max = MAX_IMAGE_DIMENSION,
): Size | null {
  const scale = max / Math.max(width, height);
  if (scale >= 1) return null;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
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

// Returns a smaller copy in the same format, or null to keep the original.
async function shrinkImage(
  file: Blob,
  type: string,
): Promise<{ blob: Blob; from: Size; to: Size } | null> {
  if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") {
    return null;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const from = { width: bitmap.width, height: bitmap.height };
    const to = fitWithin(from.width, from.height);
    if (!to) return null;
    const canvas = new OffscreenCanvas(to.width, to.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, to.width, to.height);
    const blob = await canvas.convertToBlob({ type, quality: JPEG_WEBP_QUALITY });
    // Browsers silently fall back to PNG for formats they cannot encode.
    if (blob.type !== type || blob.size >= file.size) return null;
    return { blob, from, to };
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

export async function readArtifactFile(
  file: File,
  name: string,
): Promise<{ file: ArtifactFile; resized: ResizedImage | null }> {
  const detected = detectType(name);
  const type = detected === "text/plain" && file.type ? file.type : detected;

  if (!BINARY_RE.test(name)) {
    return {
      file: { name, type, content: await file.text(), encoding: "utf8" },
      resized: null,
    };
  }

  const shrunk = RESIZABLE_RE.test(name) ? await shrinkImage(file, type) : null;
  return {
    file: {
      name,
      type,
      content: await toBase64(shrunk?.blob ?? file),
      encoding: "base64",
    },
    resized: shrunk ? { name, from: shrunk.from, to: shrunk.to } : null,
  };
}

export function describeResized(images: ResizedImage[]): string | null {
  if (!images.length) return null;
  const list = images
    .map(({ name, from, to }) => `${name} (${from.width}×${from.height} → ${to.width}×${to.height})`)
    .join(", ");
  return `Resized ${images.length === 1 ? "a large image" : `${images.length} large images`} to fit the upload limit: ${list}.`;
}
