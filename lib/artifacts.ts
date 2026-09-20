"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { nanoid } from "nanoid";
import { currentAllowedUser } from "@/lib/auth";
import { supabaseData } from "@/lib/supabase/data";
import type { ArtifactKind, ArtifactFile } from "@/lib/renderer";
import { MIN_DESCRIPTION_CHARS } from "@/lib/validation";
import type { ArtifactFilesUpload } from "@/lib/artifact-transfer";
import { readArtifactFiles } from "@/lib/artifact-transfer.server";

const MAX_BUNDLE_BYTES = 6 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 1000;

function titleInvalid(title: string, isCreate: boolean): string | null {
  if (!title) return "Title is required.";
  if (isCreate && title === "Untitled") return "Title is required.";
  return null;
}

function descriptionInvalid(description: string): string | null {
  if (!description) return "Description is required.";
  if (description.length < MIN_DESCRIPTION_CHARS) {
    return `Description must be at least ${MIN_DESCRIPTION_CHARS} characters.`;
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return `Description must be ${MAX_DESCRIPTION_CHARS} characters or fewer.`;
  }
  return null;
}

function fileByteSize(f: ArtifactFile): number {
  if (!f.content) return 0;
  return f.encoding === "base64"
    ? Buffer.from(f.content, "base64").length
    : Buffer.byteLength(f.content, "utf8");
}

function bundleTooBig(files: ArtifactFile[]): string | null {
  const total = files.reduce((sum, f) => sum + fileByteSize(f), 0);
  if (total > MAX_BUNDLE_BYTES) {
    const mb = (total / 1024 / 1024).toFixed(1);
    const limit = (MAX_BUNDLE_BYTES / 1024 / 1024).toFixed(0);
    return `Artifact is ${mb} MB. Limit is ${limit} MB — compress images or remove files.`;
  }
  return null;
}

async function getShareToken(
  id: string,
  ownerId: string,
): Promise<string | null> {
  const supabase = supabaseData();
  const { data } = await supabase
    .from("artifacts")
    .select("share_token")
    .eq("id", id)
    .eq("owner", ownerId)
    .maybeSingle();
  return (data?.share_token as string | null) ?? null;
}

async function getShareState(
  id: string,
  ownerId: string,
): Promise<{ share_token: string | null; in_directory: boolean }> {
  const supabase = supabaseData();
  const { data } = await supabase
    .from("artifacts")
    .select("share_token, in_directory")
    .eq("id", id)
    .eq("owner", ownerId)
    .maybeSingle();
  return {
    share_token: (data?.share_token as string | null) ?? null,
    in_directory: Boolean(data?.in_directory),
  };
}

function bustShares(tokens: Array<string | null>) {
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t && !seen.has(t)) {
      seen.add(t);
      revalidatePath(`/s/${t}`);
    }
  }
}

export async function createArtifact(input: {
  title: string;
  kind: ArtifactKind;
  files: ArtifactFilesUpload;
  entry: string | null;
  description?: string | null;
  inDirectory?: boolean;
}) {
  const user = await currentAllowedUser();
  if (!user) {
    return { error: "Not signed in" };
  }
  const supabase = supabaseData();

  const title = input.title.trim();
  const titleErr = titleInvalid(title, true);
  if (titleErr) return { error: titleErr };

  const description = input.description?.trim() ?? "";
  const descErr = descriptionInvalid(description);
  if (descErr) return { error: descErr };

  const decoded = await readArtifactFiles(input.files);
  if ("error" in decoded) return decoded;
  const files = decoded.files;
  if (!files.length) {
    return { error: "Add at least one file" };
  }

  const sizeError = bundleTooBig(files);
  if (sizeError) return { error: sizeError };

  const inDirectory = input.inDirectory ?? false;
  const { data, error } = await supabase
    .from("artifacts")
    .insert({
      owner: user.id,
      owner_email: user.email,
      title,
      kind: input.kind,
      files,
      entry: input.entry,
      description,
      in_directory: inDirectory,
      share_token: inDirectory ? nanoid(12) : null,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  if (input.inDirectory) revalidatePath("/directory");
  return { id: data.id };
}

export async function updateArtifact(
  id: string,
  patch: {
    title?: string;
    files?: ArtifactFilesUpload;
    entry?: string | null;
    kind?: ArtifactKind;
    description?: string | null;
    inDirectory?: boolean;
  },
) {
  const user = await currentAllowedUser();
  if (!user) return { error: "Not signed in" };
  const supabase = supabaseData();

  const normalized = { ...patch } as Record<string, unknown>;
  if (patch.files !== undefined) {
    const decoded = await readArtifactFiles(patch.files);
    if ("error" in decoded) return decoded;
    const sizeError = bundleTooBig(decoded.files);
    if (sizeError) return { error: sizeError };
    normalized.files = decoded.files;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "title")) {
    const trimmed = patch.title?.trim() ?? "";
    const titleErr = titleInvalid(trimmed, false);
    if (titleErr) return { error: titleErr };
    normalized.title = trimmed;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "description")) {
    const trimmed = patch.description?.trim() ?? "";
    const descErr = descriptionInvalid(trimmed);
    if (descErr) return { error: descErr };
    normalized.description = trimmed;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "inDirectory")) {
    normalized.in_directory = patch.inDirectory;
    delete normalized.inDirectory;
  }

  const existingToken = await getShareToken(id, user.id);

  if (patch.inDirectory === true && !existingToken) {
    normalized.share_token = nanoid(12);
  }

  const { error } = await supabase
    .from("artifacts")
    .update(normalized)
    .eq("id", id)
    .eq("owner", user.id);
  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  revalidatePath("/directory");
  revalidatePath(`/a/${id}`);
  revalidatePath(`/d/${id}`);
  bustShares([existingToken]);
  return { ok: true };
}

export async function toggleDirectory(id: string, inDirectory: boolean) {
  const user = await currentAllowedUser();
  if (!user) return { error: "Not signed in" };
  const supabase = supabaseData();

  const patch: Record<string, unknown> = { in_directory: inDirectory };
  if (inDirectory) {
    const existingToken = await getShareToken(id, user.id);
    if (!existingToken) patch.share_token = nanoid(12);
  }

  const { error } = await supabase
    .from("artifacts")
    .update(patch)
    .eq("id", id)
    .eq("owner", user.id);
  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  revalidatePath("/directory");
  revalidatePath(`/a/${id}`);
  return { in_directory: inDirectory };
}

export async function toggleShare(id: string, share: boolean) {
  const user = await currentAllowedUser();
  if (!user) return { error: "Not signed in" };
  const supabase = supabaseData();

  const { share_token: existingToken, in_directory } = await getShareState(
    id,
    user.id,
  );
  if (!share && in_directory) {
    return { error: "Remove from the SVS Directory first." };
  }
  const share_token = share ? nanoid(12) : null;

  const { error } = await supabase
    .from("artifacts")
    .update({ share_token })
    .eq("id", id)
    .eq("owner", user.id);
  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  revalidatePath("/directory");
  revalidatePath(`/a/${id}`);
  bustShares([existingToken, share_token]);
  return { share_token };
}

export async function deleteArtifact(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const user = await currentAllowedUser();
  if (!user) return;
  const supabase = supabaseData();

  const existingToken = await getShareToken(id, user.id);

  await supabase
    .from("artifacts")
    .delete()
    .eq("id", id)
    .eq("owner", user.id);

  revalidatePath("/dashboard");
  revalidatePath("/directory");
  bustShares([existingToken]);
  redirect("/dashboard");
}
