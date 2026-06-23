import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCaptionPrompt,
  buildCaptionSystemPrompt,
  cleanCaptionContent,
  ensureCaptionPrefix,
  extractCaptionFromModelMessage,
  hasCaptionDetails,
  normalizeBaseUrl,
  normalizeCaptionSettings,
  optimizeCaption
} from "../server/lib/lmstudio.js";

test("normalizes LM Studio base URLs", () => {
  assert.equal(normalizeBaseUrl("127.0.0.1:1234"), "http://127.0.0.1:1234/v1");
  assert.equal(normalizeBaseUrl("http://localhost:1234/v1/"), "http://localhost:1234/v1");
});

test("cleans model captions into a single comma-separated line", () => {
  const cleaned = cleanCaptionContent(`
    Caption:
    - red jacket, studio light
    - red jacket
    - portrait framing
  `);

  assert.equal(cleaned, "red jacket, studio light, portrait framing");
});

test("removes low-value prompt booster tags from captions", () => {
  const cleaned = cleanCaptionContent("masterpiece, best quality, 8k, photo of red jacket, soft studio light");

  assert.equal(cleaned, "red jacket, soft studio light");
});

test("removes uncertain or model-limitation tags from captions", () => {
  const cleaned = cleanCaptionContent(
    "person, maybe blue jacket, looks like a famous actor, no visible logo, three-quarter view, soft window light"
  );

  assert.equal(cleaned, "person, three-quarter view, soft window light");
});

test("keeps Stable Diffusion tags that start with numbers", () => {
  assert.equal(cleanCaptionContent("1girl, blue hair, portrait"), "1girl, blue hair, portrait");
});

test("adds trigger and class tokens when the model omits them", () => {
  const settings = normalizeCaptionSettings({
    triggerToken: "sks_person",
    classToken: "person"
  });

  assert.equal(
    ensureCaptionPrefix("portrait, soft light", settings),
    "sks_person person, portrait, soft light"
  );
});

test("does not turn an empty model response into a trigger-only caption", () => {
  const settings = normalizeCaptionSettings({
    triggerToken: "sks_fashion",
    classToken: "person"
  });

  assert.equal(ensureCaptionPrefix("", settings), "");
  assert.equal(hasCaptionDetails("sks_fashion person", settings), false);
  assert.equal(hasCaptionDetails("sks_fashion person, I cannot view images", settings), false);
  assert.equal(hasCaptionDetails("sks_fashion person, tan blazer, walking pose", settings), true);
});

test("keeps the trigger phrase as the first comma-separated tag", () => {
  const settings = normalizeCaptionSettings({
    triggerToken: "sks_person",
    classToken: "person"
  });

  assert.equal(
    ensureCaptionPrefix("sks_person person portrait, person, best quality, soft light", settings),
    "sks_person person, portrait, soft light"
  );
});

test("extracts a final caption from reasoning content when API content is empty", () => {
  const settings = normalizeCaptionSettings({
    triggerToken: "sks_fashion",
    classToken: "person",
    captionMode: "character"
  });
  const content = extractCaptionFromModelMessage(
    {
      content: "",
      reasoning_content: `
        The user wants a caption.
        Output shape: sks_fashion person, subject detail, pose or view.
        Final caption: sks_fashion person, woman, sunglasses, tan oversized blazer, dark leather trousers, patterned clutch bag, walking pose, cobblestone plaza, natural sunlight
      `
    },
    settings
  );

  assert.equal(
    content,
    "sks_fashion person, woman, sunglasses, tan oversized blazer, dark leather trousers, patterned clutch bag, walking pose, cobblestone plaza, natural sunlight"
  );
});

test("builds a LoRA-aware caption prompt", () => {
  const settings = normalizeCaptionSettings({
    triggerToken: "sks_style",
    classToken: "style",
    captionMode: "style",
    customPrompt: "prefer concise tags"
  });
  const systemPrompt = buildCaptionSystemPrompt();
  const prompt = buildCaptionPrompt(settings);

  assert.equal(settings.promptVersion, "lora-caption-v6");
  assert.match(systemPrompt, /Stable Diffusion LoRA training/);
  assert.match(systemPrompt, /local vision-language model/);
  assert.match(prompt, /keep_tokens = 1/);
  assert.match(prompt, /First tag requirement: start with exactly "sks_style style"/);
  assert.match(prompt, /Description quality:/);
  assert.match(prompt, /Silent workflow:/);
  assert.match(prompt, /Profile: Style LoRA/);
  assert.match(prompt, /prefer concise tags/);
});

test("builds a face-focused caption prompt", () => {
  const settings = normalizeCaptionSettings({
    triggerToken: "sks_dima",
    classToken: "person",
    captionMode: "face"
  });
  const prompt = buildCaptionPrompt(settings);

  assert.equal(settings.captionMode, "face");
  assert.match(prompt, /Profile: Face \/ portrait LoRA/);
  assert.match(prompt, /portrait framing, face angle or view, gaze direction, expression/);
  assert.match(prompt, /lighting on the face/);
  assert.match(prompt, /First tag requirement: start with exactly "sks_dima person"/);
});

test("normalizes retry count for transient LM Studio failures", () => {
  assert.equal(normalizeCaptionSettings({ retryCount: 3 }).retryCount, 3);
  assert.equal(normalizeCaptionSettings({ retryCount: 99 }).retryCount, 5);
});

test("keeps a safe generation budget for reasoning models", () => {
  assert.equal(normalizeCaptionSettings({ maxTokens: 220 }).maxTokens, 2048);
  assert.equal(normalizeCaptionSettings({ maxTokens: 4096 }).maxTokens, 4096);
  assert.equal(normalizeCaptionSettings({ maxTokens: 99999 }).maxTokens, 8192);
});

test("optimizes generated captions into compact high-signal tags", () => {
  const settings = normalizeCaptionSettings({
    triggerToken: "sks_fashion",
    classToken: "person",
    captionMode: "character"
  });
  const caption = optimizeCaption(
    "sks_fashion person, woman, brunette hair, wearing sunglasses, gold hoop earrings, confident expression, walking pose, full body shot, mid-stride, camel blazer, oversized jacket, white t-shirt underneath, dark grey leather trousers, wide leg pants, black pointed toe heels, patterned clutch bag, monogram bag under arm, outdoor plaza, cobblestone street, classical architecture, stone arches, blurred background, city square, distant pedestrians, parked car, natural sunlight, bright day, soft shadows, shallow depth of field, bokeh, sharp focus on subject, street photography style, fashion editorial",
    settings
  );
  const tags = caption.split(", ");

  assert.equal(tags[0], "sks_fashion person");
  assert.ok(tags.length <= 24);
  assert.equal(tags.includes("oversized jacket"), false);
  assert.equal(tags.includes("monogram bag under arm"), false);
  assert.equal(tags.includes("bokeh"), false);
  assert.equal(tags.includes("sharp focus on subject"), false);
});
