import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCaptionCsv,
  buildCaptionJsonl,
  buildKohyaDatasetGuide,
  buildKohyaDatasetToml,
  buildTrainingNotes,
  getDatasetLayout
} from "../server/lib/dataset.js";
import { normalizeCaptionSettings } from "../server/lib/lmstudio.js";

function makeJob() {
  return {
    id: "job-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    processed: 1,
    failed: 0,
    total: 1,
    settings: normalizeCaptionSettings({
      model: "vision-model",
      triggerToken: "sks_person",
      classToken: "person",
      folderName: "portrait-dataset",
      repeats: 12
    }),
    items: [
      {
        originalName: "portrait.png",
        storedName: "0001_portrait.png",
        status: "done",
        caption: "sks_person person, portrait, soft light"
      }
    ]
  };
}

test("builds a trainer-friendly dataset layout", () => {
  const layout = getDatasetLayout(makeJob().settings);

  assert.equal(layout.trainParentPath, "portrait-dataset/train");
  assert.equal(layout.trainingPath, "portrait-dataset/train/12_sks_person-person");
  assert.equal(layout.captionExtension, ".txt");
});

test("exports kohya config and caption indexes", () => {
  const job = makeJob();
  const layout = getDatasetLayout(job.settings);

  assert.match(buildKohyaDatasetToml(job, layout), /image_dir = "\.\/train\/12_sks_person-person"/);
  assert.match(buildKohyaDatasetToml(job, layout), /num_repeats = 12/);
  assert.match(buildCaptionJsonl(job, layout), /0001_portrait\.txt/);
  assert.match(buildCaptionCsv(job, layout), /sks_person person, portrait, soft light/);
  assert.match(buildTrainingNotes(job, layout), /Trigger phrase: sks_person person/);
  assert.match(buildKohyaDatasetGuide(job, layout), /portrait-dataset\/train/);
  assert.match(buildKohyaDatasetGuide(job, layout), /keep_tokens = 1/);
  assert.match(buildKohyaDatasetGuide(job, layout), /Network module: networks\.lora/);
});
