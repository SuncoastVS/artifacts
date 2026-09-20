import type { ArtifactFile } from "@/lib/renderer";

export type ArtifactFilesUpload = ArtifactFile[] | Blob;

// Leave room for the Server Action's multipart envelope and other fields.
export const MAX_COMPRESSED_UPLOAD_BYTES = 3 * 1024 * 1024;
const COMPRESSION_THRESHOLD_BYTES = 1024 * 1024;
export const UPLOAD_TOO_LARGE =
  "This artifact is too large to upload even after compression. Reduce image sizes or remove files, then try again. Your files are still in the editor.";

export class ArtifactUploadError extends Error {}

export async function prepareArtifactFiles(
  files: ArtifactFile[],
): Promise<ArtifactFilesUpload> {
  const json = new Blob([JSON.stringify(files)], { type: "application/json" });
  if (json.size <= COMPRESSION_THRESHOLD_BYTES) return files;

  if (typeof CompressionStream === "undefined") {
    throw new ArtifactUploadError(
      "Your browser cannot compress this upload. Update your browser or reduce the file size. Your files are still in the editor.",
    );
  }

  const compressed = await new Response(
    json.stream().pipeThrough(new CompressionStream("gzip")),
  ).blob();
  if (compressed.size > MAX_COMPRESSED_UPLOAD_BYTES) {
    throw new ArtifactUploadError(UPLOAD_TOO_LARGE);
  }
  return compressed;
}
