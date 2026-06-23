# LoRA Caption Studio

[Russian README](README_ru.md)

A local web application for captioning images for Stable Diffusion LoRA training. The backend connects to LM Studio through its OpenAI-compatible API, sends images to a vision model, saves captions, and builds a ZIP archive with a LoRA-ready dataset.

## ZIP Output

```text
lora-dataset/
  README.txt
  training-notes.txt
  kohya_ss_dataset_guide.md
  dataset.toml
  captions.csv
  captions.jsonl
  metadata.json
  train/
    10_sks_person-person/
      0001_image.jpg
      0001_image.txt
      0002_image.png
      0002_image.txt
```

Each image has a matching `.txt` file with the same basename. For Kohya folder mode, point the trainer to `lora-dataset/train`. For dataset config mode, use `dataset.toml` from the archive.

The detailed guide for preparing a `kohya_ss` dataset, folder layout, trigger phrase, repeats, and captions is in [docs/kohya_ss_dataset_guide.md](docs/kohya_ss_dataset_guide.md).

## Running

1. Install Node.js 20 or newer.
2. Load a vision-capable model in LM Studio.
3. Enable the local OpenAI-compatible server in LM Studio. The usual address is:

```text
http://127.0.0.1:1234/v1
```

4. Start the app:

```bash
npm start
```

5. Open:

```text
http://127.0.0.1:5177
```

## Workflow

1. Check the LM Studio connection so the app can see the model loaded in LM Studio.
2. Select the model and LoRA type: face, character, style, object, or general.
3. Enter the LoRA name. The app prepares the trigger token, repeats, and archive folder automatically.
4. Add images by selecting files, dragging them into the window, or pasting from the clipboard.
5. Start captioning.
6. Review captions in the image cards. Edit text if needed and save the changes.
7. Download the archive.

After a page reload, the latest completed dataset can be reopened from the latest dataset panel.

The UI opens in simple mode by default. The advanced settings button shows technical fields for experienced users: LM Studio API address/API key, class token, caption profile, trigger token, repeats, ZIP folder name, temperature, max tokens, timeout, retries, and additional prompt.

The generation budget in advanced settings is not the model context window. It controls how many output tokens LM Studio may spend on the API response. For reasoning models, this budget includes hidden reasoning tokens, so the default is 2048 even for short captions.

## LoRA Caption Logic

The caption prompt is already tuned for LoRA dataset preparation:

- the first comma-separated tag always contains the trigger phrase, for example `sks_person person`;
- `dataset.toml` uses `shuffle_caption = true`, `keep_tokens = 1`, and `caption_extension = ".txt"`, so the trigger remains fixed during caption shuffling;
- the model receives a profile-specific strategy for `Face`, `Character`, `Style`, `Object`, or `General`;
- captions describe only visible training-relevant details: pose, view, clothing, materials, colors, background, lighting, medium/style, and composition;
- the default caption targets roughly 16-24 useful tags without a long list of repeated ideas;
- for character LoRA, the trigger is used as the identity anchor, while changeable details are captioned so they do not get baked into the concept;
- for face/portrait LoRA, captions focus more strongly on portrait framing, face angle, gaze, expression, hair around the face, glasses, facial hair, makeup, occlusion, and lighting on the face;
- for style LoRA, both image content and style are captioned so the style does not bind to a single subject;
- for product/object LoRA, captions describe shape, material, color, angle, environment, and lighting;
- low-value booster tags such as `masterpiece`, `best quality`, `8k`, `highres`, and `watermark` are automatically removed from model responses;
- the backend also compacts near-duplicate tags by groups such as clothing, footwear, bags, background, architecture, lighting, depth of field, and photo style;
- the additional prompt in the UI can refine vocabulary, but the base `trigger, tag, tag...` format is preserved.

## Writing Good Descriptions

A good caption tells the model what belongs to the LoRA concept and what is a variable detail of the specific image. Write descriptions as verifiable visual facts, not as a pretty generation prompt.

Practical rules:

- one tag should carry one main visual idea: `red leather jacket`, `three-quarter view`, `soft window light`;
- variable details must be captioned explicitly so they do not stick to the trigger: clothing, expression, pose, crop, background, lighting, material, color;
- if a detail is not obvious, choose a neutral visible term: `person`, `printed text`, `storefront`, `device`, `patterned fabric`;
- do not guess names, brands, exact OCR text, location, artist, or hidden context;
- do not mix synonyms and contradictions: prefer `tan oversized blazer` over `camel blazer, oversized jacket, coat`;
- do not add absent details such as `no logo`, `no background`, or `not visible`;
- do not use `maybe`, `probably`, `looks like`, or `appears to be`; these tags confuse both the local LLM and the LoRA being trained.

Good caption example:

```text
sks_person person, close-up portrait, looking at camera, red leather jacket, short dark hair, blurred city background, soft daylight, photo
```

Bad caption example:

```text
sks_person person, beautiful, best quality, maybe celebrity, looks like a brand jacket, no logo, ultra detailed
```

## Reliability

- Jobs are saved to disk in `.captioner/jobs/`, and completed archives remain available after a server restart.
- If the server restarts during processing, completed captions are preserved and unfinished images are marked with an error.
- Processing runs through one global queue so multiple batch jobs do not overload the local LM Studio model.
- Temporary LM Studio failures are retried automatically. The number of retries is controlled by `Retries`.
- The active queue can be cancelled; new images are not processed after cancellation.

## Environment Settings

```bash
HOST=127.0.0.1 npm start
PORT=5177 npm start
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1 npm start
LMSTUDIO_API_KEY=local-key npm start
MAX_UPLOAD_MB=1200 npm start
MAX_FILES=500 npm start
```

Uploaded job files and archives are stored locally in `.captioner/jobs/`. This folder is included in `.gitignore`.

## Checks

```bash
npm test
```
