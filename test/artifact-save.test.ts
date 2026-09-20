import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFile } from "@/lib/renderer";

const { user, insert, update, eq, single, maybeSingle } = vi.hoisted(() => ({
  user: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ currentAllowedUser: user }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/data", () => ({
  supabaseData: () => {
    const query = {
      insert,
      update,
      eq,
      single,
      maybeSingle,
      select: () => query,
    };
    insert.mockReturnValue(query);
    update.mockReturnValue(query);
    eq.mockReturnValue(query);
    return { from: () => query };
  },
}));

import * as actions from "@/lib/artifacts";
import { saveArtifact } from "@/lib/save-artifact";
import { prepareArtifactFiles } from "@/lib/artifact-transfer";

const file = (content: string): ArtifactFile => ({
  name: "palletizer.html",
  type: "text/html",
  encoding: "utf8",
  content,
});
const input = (files: ArtifactFile[]) => ({
  title: "CRX Palletizer",
  description: "Interactive palletizing cell",
  kind: "html" as const,
  entry: "palletizer.html",
  files,
  inDirectory: false,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  user.mockResolvedValue({ id: "owner-1", email: "owner@example.com" });
  single.mockResolvedValue({ data: { id: "artifact-1" }, error: null });
  maybeSingle.mockResolvedValue({ data: { share_token: null }, error: null });
});

describe("artifact save transport", () => {
  it("compresses a large HTML upload and saves the exact original contents", async () => {
    const files = [file(`<script>${"const mesh = 'robot';\n".repeat(225_000)}</script>`)];
    const payload = await prepareArtifactFiles(files);
    expect(payload).toBeInstanceOf(Blob);
    expect((payload as Blob).size).toBeLessThan(3 * 1024 * 1024);

    await expect(saveArtifact(input(files))).resolves.toEqual({ id: "artifact-1" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ files }));
  });

  it("updates compressed artifacts with the existing owner restriction", async () => {
    const files = [file("🌴".repeat(300_000))];
    await expect(saveArtifact(input(files), "artifact-1")).resolves.toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ files }));
    expect(eq).toHaveBeenCalledWith("id", "artifact-1");
    expect(eq).toHaveBeenCalledWith("owner", "owner-1");
  });

  it("keeps supporting small and legacy uncompressed saves", async () => {
    const files = [file("<h1>Hello</h1>")];
    expect(await prepareArtifactFiles(files)).toBe(files);
    await expect(actions.createArtifact(input(files))).resolves.toEqual({ id: "artifact-1" });
  });

  it.each([undefined, "artifact-1"])("returns upload failures to the editor instead of rejecting (id=%s)", async (id) => {
    vi.spyOn(actions, id ? "updateArtifact" : "createArtifact")
      .mockRejectedValue(new Error("An unexpected response was received from the server."));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = input([file("<h1>Keep my work</h1>")]);
    await expect(saveArtifact(original, id)).resolves.toEqual({
      error: expect.stringContaining("Your files are still in the editor"),
    });
    expect(original.files[0].content).toBe("<h1>Keep my work</h1>");
  });

  it("blocks files that remain too large after compression before calling the server", async () => {
    const create = vi.spyOn(actions, "createArtifact");
    const files: ArtifactFile[] = [{
      name: "image.png", type: "image/png", encoding: "base64",
      content: randomBytes(4 * 1024 * 1024).toString("base64"),
    }];
    const result = await saveArtifact(input(files));
    expect(result).toEqual({ error: expect.stringContaining("too large to upload") });
    expect(create).not.toHaveBeenCalled();
  });

  it("enforces the original content limit after decompression", async () => {
    const files = [file("x".repeat(6 * 1024 * 1024 + 1))];
    const compressed = new Blob([gzipSync(JSON.stringify(files))]);
    await expect(actions.createArtifact({ ...input(files), files: compressed })).resolves.toEqual({
      error: expect.stringContaining("Limit is 6 MB"),
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([
    new Blob(["not gzip"]),
    new Blob([gzipSync("not json")]),
    new Blob([gzipSync(JSON.stringify([{ name: "bad.html", content: 42 }]))]),
  ])("rejects invalid compressed data without writing to storage", async (files) => {
    await expect(actions.createArtifact({ ...input([]), files })).resolves.toEqual({
      error: expect.stringContaining("read"),
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("checks authentication before decoding uploaded data", async () => {
    user.mockResolvedValue(null);
    await expect(actions.createArtifact({ ...input([]), files: new Blob(["invalid"]) }))
      .resolves.toEqual({ error: "Not signed in" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("bounds decompression before parsing oversized JSON", async () => {
    const compressed = new Blob([gzipSync(" ".repeat(41 * 1024 * 1024))]);
    await expect(actions.updateArtifact("artifact-1", { files: compressed }))
      .resolves.toEqual({ error: expect.stringContaining("read") });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects oversized compressed uploads on the server as well", async () => {
    const compressed = new Blob([new Uint8Array(3 * 1024 * 1024 + 1)]);
    await expect(actions.updateArtifact("artifact-1", { files: compressed }))
      .resolves.toEqual({ error: expect.stringContaining("too large to upload") });
    expect(update).not.toHaveBeenCalled();
  });
});
