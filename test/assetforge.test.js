const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatOf,
  readDimensions,
  inspectImage,
  parseLimit,
  validateLottie,
  AssetForgeUserError
} = require("../assetforge").__test;

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpegSof(width, height) {
  const buffer = Buffer.alloc(21);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

function webpVp8x(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

test("format detection relies on byte signatures, not user-controlled MIME", () => {
  assert.equal(formatOf(pngHeader(32, 32)), "png");
  assert.equal(formatOf(Buffer.from("MZ this is not a PNG")), "unknown");
  assert.equal(formatOf(Buffer.from("MZ this is not a PNG"), "image/png"), "unknown");
});

test("PNG dimensions are read from IHDR before image decoding", () => {
  assert.deepEqual(readDimensions(pngHeader(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(inspectImage(pngHeader(640, 480), ["png"]), {
    format: "png", width: 640, height: 480, animated: false
  });
});

test("JPEG SOF dimensions are parsed", () => {
  const buffer = jpegSof(640, 480);
  assert.equal(formatOf(buffer), "jpg");
  assert.deepEqual(readDimensions(buffer, "jpg"), { width: 640, height: 480 });
});

test("WebP VP8X dimensions are parsed", () => {
  const buffer = webpVp8x(320, 320);
  assert.equal(formatOf(buffer), "webp");
  assert.deepEqual(readDimensions(buffer, "webp"), { width: 320, height: 320 });
});

test("oversized declared dimensions are rejected before decoding", () => {
  assert.throws(
    () => inspectImage(pngHeader(50000, 50000), ["png"]),
    AssetForgeUserError
  );
  assert.throws(
    () => inspectImage(pngHeader(0, 0), ["png"]),
    AssetForgeUserError
  );
});

test("compression targets are bounded and parsed as binary units", () => {
  assert.equal(parseLimit("256kb"), 256 * 1024);
  assert.equal(parseLimit("8mb"), 8 * 1024 * 1024);
  assert.equal(parseLimit("15kb"), null);
  assert.equal(parseLimit("9mb"), null);
  assert.equal(parseLimit("banana"), null);
});

test("Lottie validation requires a bounded 320x320 self-contained document", () => {
  const valid = Buffer.from(JSON.stringify({
    v: "5.7.4", fr: 30, ip: 0, op: 30, w: 320, h: 320, layers: [], assets: []
  }));
  assert.equal(formatOf(valid), "json");
  assert.equal(validateLottie(valid), valid);

  const externalAssets = Buffer.from(JSON.stringify({
    v: "5.7.4", fr: 30, ip: 0, op: 30, w: 320, h: 320, layers: [],
    assets: [{ id: "image_0", w: 320, h: 320, u: "https://example.invalid/", p: "image.png" }]
  }));
  assert.throws(() => validateLottie(externalAssets), AssetForgeUserError);
});

test("unknown formats are rejected by image inspection", () => {
  assert.throws(() => inspectImage(Buffer.from("not an image"), ["png", "jpg"]), AssetForgeUserError);
});
