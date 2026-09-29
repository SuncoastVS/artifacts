import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCEPTED_FILE_TYPES,
  MAX_IMAGE_DIMENSION,
  SUPPORTED_FILE_RE,
  describeResized,
  fitWithin,
  readArtifactFile,
} from "@/lib/file-ingest";
import { buildHtmlDocument } from "@/lib/renderer";

const bytes = (n: number) => new Uint8Array(n).map((_, i) => i % 251);

type FakeImage = { width: number; height: number; encoded?: Blob };

// Node has no image codecs; stand in for the browser APIs the resizer uses.
function stubImageApis({ width, height, encoded }: FakeImage) {
  const drawImage = vi.fn();
  const convertToBlob = vi.fn(
    async ({ type }: { type: string }) => encoded ?? new Blob([bytes(10)], { type }),
  );
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width, height, close: vi.fn() })));
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage };
      }
      convertToBlob = convertToBlob;
    },
  );
  return { drawImage, convertToBlob };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("file ingest", () => {
  it.each(["woff2", "woff", "ttf", "otf"])("accepts .%s fonts as binary files", async (ext) => {
    const data = bytes(64);
    const { file } = await readArtifactFile(new File([data], `font.${ext}`), `assets/font.${ext}`);
    expect(SUPPORTED_FILE_RE.test(`font.${ext}`)).toBe(true);
    expect(ACCEPTED_FILE_TYPES.split(",")).toContain(`.${ext}`);
    expect(file).toEqual({
      name: `assets/font.${ext}`,
      type: `font/${ext}`,
      encoding: "base64",
      content: Buffer.from(data).toString("base64"),
    });
  });

  it("reads source files as UTF-8 text", async () => {
    const { file, resized } = await readArtifactFile(new File(["body{}"], "a.css"), "styles/a.css");
    expect(file).toEqual({ name: "styles/a.css", type: "text/css", encoding: "utf8", content: "body{}" });
    expect(resized).toBeNull();
  });

  it("falls back to the browser's type for extensions it does not know", async () => {
    const { file } = await readArtifactFile(new File(["# hi"], "notes.md", { type: "text/markdown" }), "notes.md");
    expect(file.type).toBe("text/markdown");
  });

  it("fits oversized images within the maximum dimension, keeping the aspect ratio", () => {
    expect(MAX_IMAGE_DIMENSION).toBe(2048);
    expect(fitWithin(3888, 2592)).toEqual({ width: 2048, height: 1365 });
    expect(fitWithin(2592, 3888)).toEqual({ width: 1365, height: 2048 });
    expect(fitWithin(2048, 1000)).toBeNull();
    expect(fitWithin(1024, 683)).toBeNull();
  });

  it("shrinks a camera-sized photo and keeps its path and format", async () => {
    const encoded = new Blob([bytes(100)], { type: "image/jpeg" });
    const { drawImage, convertToBlob } = stubImageApis({ width: 3888, height: 2592, encoded });
    const original = new File([bytes(5000)], "conveyor.jpg", { type: "image/jpeg" });

    const { file, resized } = await readArtifactFile(original, "equipment/conveyor.jpg");

    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2048, 1365);
    expect(convertToBlob).toHaveBeenCalledWith(expect.objectContaining({ type: "image/jpeg" }));
    expect(file).toEqual({
      name: "equipment/conveyor.jpg",
      type: "image/jpeg",
      encoding: "base64",
      content: Buffer.from(bytes(100)).toString("base64"),
    });
    expect(resized).toEqual({
      name: "equipment/conveyor.jpg",
      from: { width: 3888, height: 2592 },
      to: { width: 2048, height: 1365 },
    });
  });

  it.each([
    ["the re-encode is not smaller", new Blob([bytes(6000)], { type: "image/webp" })],
    ["the browser cannot encode the format", new Blob([bytes(10)], { type: "image/png" })],
  ])("keeps the original image when %s", async (_why, encoded) => {
    stubImageApis({ width: 4000, height: 3000, encoded });
    const original = new File([bytes(5000)], "photo.webp", { type: "image/webp" });
    const { file, resized } = await readArtifactFile(original, "photo.webp");
    expect(file.content).toBe(Buffer.from(bytes(5000)).toString("base64"));
    expect(resized).toBeNull();
  });

  it("leaves small images, GIFs, and SVGs untouched", async () => {
    const huge = stubImageApis({ width: 4000, height: 3000 });
    await readArtifactFile(new File([bytes(50)], "anim.gif"), "anim.gif");
    await readArtifactFile(new File(["<svg/>"], "logo.svg"), "logo.svg");
    expect(huge.drawImage).not.toHaveBeenCalled();

    const small = stubImageApis({ width: 1024, height: 683 });
    const { resized } = await readArtifactFile(new File([bytes(50)], "wrapper.png"), "wrapper.png");
    expect(small.drawImage).not.toHaveBeenCalled();
    expect(resized).toBeNull();
  });

  it("keeps the original image where the browser has no image APIs", async () => {
    const original = new File([bytes(5000)], "big.jpg", { type: "image/jpeg" });
    const { file, resized } = await readArtifactFile(original, "big.jpg");
    expect(file.content).toBe(Buffer.from(bytes(5000)).toString("base64"));
    expect(resized).toBeNull();
  });

  it("tells the author which images were resized", () => {
    expect(describeResized([])).toBeNull();
    expect(
      describeResized([
        { name: "equipment/conveyor.jpg", from: { width: 3888, height: 2592 }, to: { width: 2048, height: 1365 } },
      ]),
    ).toBe("Resized a large image to fit the upload limit: equipment/conveyor.jpg (3888×2592 → 2048×1365).");
    expect(
      describeResized([
        { name: "a.jpg", from: { width: 4000, height: 3000 }, to: { width: 2048, height: 1536 } },
        { name: "b.png", from: { width: 3000, height: 4000 }, to: { width: 1536, height: 2048 } },
      ]),
    ).toMatch(/^Resized 2 large images to fit the upload limit: a\.jpg .*, b\.png /);
  });

  it("inlines imported fonts referenced from CSS so they load in the sandbox", async () => {
    const { file: font } = await readArtifactFile(new File([bytes(64)], "m.woff2"), "assets/m.woff2");
    const html = buildHtmlDocument([
      { name: "index.html", type: "text/html", content: '<link rel="stylesheet" href="./assets/app.css">' },
      {
        name: "assets/app.css",
        type: "text/css",
        content: '@font-face{font-family:M;src:url(./m.woff2) format("woff2")}',
      },
      font,
    ]);
    expect(html).toContain(`url("data:font/woff2;base64,${font.content}")`);
  });
});
