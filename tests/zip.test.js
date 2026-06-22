import assert from "node:assert/strict";
import test from "node:test";
import { crc32, ZipBuilder } from "../server/lib/zip.js";

test("calculates known CRC32 values", () => {
  assert.equal(crc32(Buffer.from("hello")), 0x3610a686);
});

test("creates a ZIP archive with local and central directory records", () => {
  const zip = new ZipBuilder();
  zip.addFile("dataset/0001_image.txt", "sks_person person, portrait\n", new Date("2026-01-01T00:00:00Z"));
  const archive = zip.finalize();

  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.ok(archive.includes(Buffer.from("dataset/0001_image.txt")));

  const eocdOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocdOffset, -1);
  assert.equal(archive.readUInt16LE(eocdOffset + 10), 1);
});
