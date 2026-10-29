import { afterEach, expect, it, vi } from "vitest";
import { isAnimatedImage, prepareImageForUpload, prepareImagesForUpload } from "./prepare-image";
import { attachmentPresentation } from "./presentation";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function file(type = "image/jpeg", size = 1000) {
 const value = new File([new Uint8Array(size)], "photo", { type, lastModified: 42 });
 Object.defineProperty(value, "arrayBuffer", { configurable: true, value: async () => new ArrayBuffer(size) }); return value;
}
function canvas(outputSize = 100, width = 5120, height = 2560) {
 const close = vi.fn(), drawImage = vi.fn();
 vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width, height, close })));
 const element = document.createElement("canvas");
 vi.spyOn(element, "getContext").mockReturnValue({ drawImage } as never);
 const toBlob = vi.spyOn(element, "toBlob").mockImplementation((callback, mime) => callback(new Blob([new Uint8Array(outputSize)], { type: mime })));
 const original = document.createElement.bind(document);
 vi.spyOn(document, "createElement").mockImplementation((name, options) => name === "canvas" ? element : original(name, options));
 return { close, drawImage, toBlob, element };
}
it("scales a large image before uploading and releases the decoded canvas", async () => {
 const mock = canvas(); const source = file(); const result = await prepareImageForUpload(source);
 expect(result.size).toBe(100); expect(result.name).toBe(source.name); expect(result.lastModified).toBe(42);
 expect(mock.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2560, 1280);
 expect(mock.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", .85);
 expect(mock.close).toHaveBeenCalledOnce(); expect(mock.element.width).toBe(0);
});
it.each(["image/png", "image/webp"])("retains %s transparency-compatible encoding without upscaling", async mime => {
 const mock = canvas(100, 800, 600); const result = await prepareImageForUpload(file(mime));
 expect(result.type).toBe(mime); expect(mock.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 600);
});
it("keeps the original when encoded bytes grow or decoding fails", async () => {
 canvas(2000); const source = file(); expect(await prepareImageForUpload(source)).toBe(source);
 vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error("decode")); expect(await prepareImageForUpload(source)).toBe(source);
});
it("skips GIF and SVG and detects animated PNG/WebP chunks", async () => {
 const mock = canvas();
 for (const mime of ["image/gif", "image/svg+xml"]) { const source = file(mime); expect(await prepareImageForUpload(source)).toBe(source); }
 expect(createImageBitmap).not.toHaveBeenCalled(); expect(mock.drawImage).not.toHaveBeenCalled();
 const png = new Uint8Array(20); png.set([137,80,78,71,13,10,26,10]); png.set([97,99,84,76],12);
 expect(isAnimatedImage(png,"image/png")).toBe(true);
 const webp = new Uint8Array(20); webp.set(new TextEncoder().encode("RIFF")); webp.set(new TextEncoder().encode("WEBPANIM"),8);
 expect(isAnimatedImage(webp,"image/webp")).toBe(true);
 const animated = file("image/png"); Object.defineProperty(animated, "arrayBuffer", { configurable:true,value:async()=>png.buffer });
 expect(await prepareImageForUpload(animated)).toBe(animated); expect(createImageBitmap).not.toHaveBeenCalled();
});
it("prepares files sequentially and releases each bitmap before the next decode", async () => {
 const mock = canvas(); const decode = vi.mocked(createImageBitmap); let count = 0;
 decode.mockImplementation(async () => { expect(mock.close).toHaveBeenCalledTimes(count++); return { width: 100, height: 100, close: mock.close } as ImageBitmap; });
 expect(await prepareImagesForUpload([file(),file()])).toHaveLength(2); expect(mock.close).toHaveBeenCalledTimes(2);
});
it("normalizes malformed runtime attachment data without losing a valid file", () => {
 const good = { url:"/file",name:"file",size:10,mime:"image/png" };
 expect(attachmentPresentation({})).toEqual([]);
 expect(attachmentPresentation([null,{}, {...good,mime:null}, {...good,size:Infinity},good])).toEqual([good]);
});
