import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { parseMultipart } from "../server/lib/multipart.js";

test("parses fields and files from multipart data", async () => {
  const boundary = "captioner-test-boundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="settings"\r\n\r\n'),
    Buffer.from('{"model":"vision-model"}\r\n'),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="images"; filename="sample.png"\r\n'),
    Buffer.from("Content-Type: image/png\r\n\r\n"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const req = Readable.from([body]);
  req.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`
  };

  const parts = await parseMultipart(req, 1024 * 1024);

  assert.equal(parts.length, 2);
  assert.equal(parts[0].name, "settings");
  assert.equal(parts[1].filename, "sample.png");
  assert.equal(parts[1].contentType, "image/png");
  assert.deepEqual([...parts[1].data], [0x89, 0x50, 0x4e, 0x47]);
});
