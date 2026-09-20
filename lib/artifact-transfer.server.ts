import "server-only";

import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  MAX_COMPRESSED_UPLOAD_BYTES,
  UPLOAD_TOO_LARGE,
  type ArtifactFilesUpload,
} from "@/lib/artifact-transfer";
import type { ArtifactFile } from "@/lib/renderer";

const unzip = promisify(gunzip);
// The 6 MiB file-content limit is checked separately after decoding. JSON
// escaping can expand content up to sixfold; bound inflation before parsing.
const MAX_JSON_BYTES = 40 * 1024 * 1024;
const INVALID_UPLOAD = "Couldn't read the uploaded files. Try uploading them again.";

function isArtifactFile(value: unknown): value is ArtifactFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.name === "string" &&
    typeof file.type === "string" &&
    typeof file.content === "string" &&
    (file.encoding === undefined || file.encoding === "utf8" || file.encoding === "base64")
  );
}

export async function readArtifactFiles(
  upload: ArtifactFilesUpload,
): Promise<{ files: ArtifactFile[] } | { error: string }> {
  let files: unknown = upload;
  if (upload instanceof Blob) {
    if (upload.size > MAX_COMPRESSED_UPLOAD_BYTES) return { error: UPLOAD_TOO_LARGE };
    try {
      const json = await unzip(Buffer.from(await upload.arrayBuffer()), {
        maxOutputLength: MAX_JSON_BYTES,
      });
      files = JSON.parse(json.toString("utf8"));
    } catch {
      return { error: INVALID_UPLOAD };
    }
  }

  if (!Array.isArray(files) || !files.every(isArtifactFile)) {
    return { error: INVALID_UPLOAD };
  }
  return { files };
}
