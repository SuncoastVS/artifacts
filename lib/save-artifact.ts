import { createArtifact, updateArtifact } from "@/lib/artifacts";
import { ArtifactUploadError, prepareArtifactFiles } from "@/lib/artifact-transfer";
import type { ArtifactFile, ArtifactKind } from "@/lib/renderer";

type SaveInput = {
  title: string;
  description: string;
  kind: ArtifactKind;
  files: ArtifactFile[];
  entry: string | null;
  inDirectory: boolean;
};

export async function saveArtifact(input: SaveInput, id?: string) {
  try {
    const files = await prepareArtifactFiles(input.files);
    return id
      ? await updateArtifact(id, { ...input, files })
      : await createArtifact({ ...input, files });
  } catch (error) {
    if (error instanceof ArtifactUploadError) return { error: error.message };
    console.error("Artifact save failed", error);
    return {
      error:
        "Couldn't save the artifact. Your files are still in the editor. Try again, or reduce the upload size if the problem continues.",
    };
  }
}
