import fs from "node:fs/promises";
import { DEFAULT_LMSTUDIO_BASE_URL, clampNumber, httpError } from "./utils.js";

export const CAPTION_PROMPT_VERSION = "lora-caption-v5";

const SYSTEM_CAPTION_PROMPT = [
  "You are a local vision-language model used as a deterministic Stable Diffusion LoRA training caption writer.",
  "The image is attached in this request. Inspect it directly and produce one training caption.",
  "The caption teaches a diffusion model which visible details are the concept and which details are per-image variables.",
  "Do any checking silently. Return only the final caption line. Do not think step by step in the answer.",
  "Use comma-separated tags or short phrases, not prose.",
  "No markdown, JSON, bullets, numbering, quotes, filenames, dimensions, or explanations.",
  "No quality boosters: masterpiece, best quality, highres, 4k, 8k, ultra detailed, trending on artstation.",
  "Caption only visible training-relevant details. Do not guess identities, brands, OCR text, artist names, locations, or hidden context."
].join("\n");

const CORE_LORA_CAPTION_RULES = [
  "first comma tag is the trigger phrase for keep_tokens = 1",
  "then add 16-24 high-signal visible LoRA tags",
  "include subject, pose/view/framing, outfit/accessories/materials/colors, background, lighting, medium/style",
  "each tag should stay useful after shuffle_caption; keep one main visual idea per tag",
  "use one specific combined tag instead of near-duplicates, e.g. tan oversized blazer, not camel blazer plus oversized jacket",
  "avoid vague filler, quality boosters, uncertainty phrases, OCR guesses, watermark/signature/UI text",
  "do not repeat the trigger phrase later"
];

const DESCRIPTION_QUALITY_RULES = [
  "good captions separate the LoRA concept from variables that change between images",
  "write concrete visible facts, not an aesthetic generation prompt",
  "caption variable traits that should not bind to the trigger: clothing, expression, pose, crop, camera angle, background, lighting, material, color",
  "prefer generic visible wording over guesses when uncertain, e.g. person, printed text, storefront, device, patterned fabric",
  "do not write absent details, hidden context, model limitations, or phrases like maybe/probably/appears to be"
];

const CAPTION_MODES = new Map([
  [
    "balanced",
    {
      label: "General LoRA",
      strategy:
        "Balance concept, subject, pose, environment, lighting, colors, medium, and visual style."
    }
  ],
  [
    "character",
    {
      label: "Character / person LoRA",
      strategy:
        "Trigger is the identity anchor. Caption changeable traits: outfit, accessories, pose, expression, crop, camera angle, lighting, background, visible hair and framing. Do not name real people."
    }
  ],
  [
    "style",
    {
      label: "Style LoRA",
      strategy:
        "Caption content plus style so style is not tied to one subject. Include medium, technique, palette, linework, texture, lighting, composition, motifs."
    }
  ],
  [
    "product",
    {
      label: "Product / object LoRA",
      strategy:
        "Trigger is the object anchor. Caption category, shape, materials, color, surface details, angle, scale cues, environment, shadows, lighting. Avoid guessed brand names."
    }
  ]
]);

const LOW_VALUE_TAGS = new Set([
  "masterpiece",
  "best quality",
  "high quality",
  "highest quality",
  "low quality",
  "normal quality",
  "highres",
  "high res",
  "high resolution",
  "lowres",
  "low res",
  "4k",
  "8k",
  "uhd",
  "ultra hd",
  "ultra high resolution",
  "ultra detailed",
  "highly detailed",
  "extremely detailed",
  "detailed",
  "beautiful",
  "stunning",
  "award winning",
  "trending on artstation",
  "artstation",
  "watermark",
  "signature",
  "signed",
  "logo",
  "jpeg artifacts",
  "blurry",
  "sharp focus",
  "sharp focus on subject",
  "realistic texture",
  "photorealistic texture",
  "unknown",
  "unclear",
  "not visible",
  "not shown",
  "cannot determine"
]);

const CAPTION_TAG_LIMITS = {
  balanced: 24,
  character: 24,
  style: 28,
  product: 24
};

const TAG_GROUP_RULES = [
  {
    name: "outerwear",
    max: 1,
    pattern: /\b(?:blazer|jacket|coat|cardigan|outerwear)\b/i
  },
  {
    name: "lower_garment",
    max: 2,
    pattern: /\b(?:trousers|pants|jeans|skirt|shorts|leggings)\b/i
  },
  {
    name: "footwear",
    max: 1,
    pattern: /\b(?:heels|shoes|boots|sneakers|sandals|loafers)\b/i
  },
  {
    name: "bag",
    max: 1,
    pattern: /\b(?:bag|clutch|purse|handbag|backpack)\b/i
  },
  {
    name: "location",
    max: 2,
    pattern: /\b(?:plaza|square|street|pavement|sidewalk|road|cobblestone|city|outdoor)\b/i
  },
  {
    name: "architecture",
    max: 1,
    pattern: /\b(?:architecture|arches|columns|building|facade)\b/i
  },
  {
    name: "lighting",
    max: 2,
    pattern: /\b(?:sunlight|daylight|bright day|soft shadows|shadow|natural light|studio light|backlight)\b/i
  },
  {
    name: "depth",
    max: 1,
    pattern: /\b(?:blurred background|bokeh|shallow depth of field|depth of field)\b/i
  },
  {
    name: "photo_style",
    max: 1,
    pattern: /\b(?:street photography|fashion editorial|editorial|portrait photography|studio photography|street style fashion photography)\b/i
  }
];

const INVALID_CAPTION_PATTERNS = [
  /\b(?:i|we)\s+(?:can'?t|cannot|am unable to|are unable to)\s+(?:see|view|inspect|access|analyze)\b/i,
  /\b(?:i|we)\s+(?:do not|don'?t)\s+have\s+(?:access|the ability)\b/i,
  /\bas\s+(?:an?\s+)?(?:text|language)-based\s+(?:ai|model)\b/i,
  /\bno\s+image\s+(?:was|is)\s+(?:provided|attached|available)\b/i,
  /\bplease\s+(?:upload|provide|attach)\s+(?:an?\s+)?image\b/i,
  /\bunable\s+to\s+generate\s+(?:a\s+)?caption\b/i,
  /\b(?:maybe|probably|possibly|unclear|unknown|not\s+sure|hard\s+to\s+tell|can'?t\s+tell)\b/i,
  /\b(?:appears|seems|looks)\s+(?:to\s+be|like)\b/i,
  /\bno\s+(?:visible\s+)?(?:background|text|logo|watermark|signature|people|person)\b/i
];

export function normalizeBaseUrl(rawBaseUrl) {
  let value = String(rawBaseUrl || DEFAULT_LMSTUDIO_BASE_URL).trim();
  if (!value) value = DEFAULT_LMSTUDIO_BASE_URL;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;

  const url = new URL(value);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/v1";
  }

  return url.toString().replace(/\/$/, "");
}

export function normalizeCaptionSettings(rawSettings = {}) {
  const captionMode = CAPTION_MODES.has(rawSettings.captionMode)
    ? rawSettings.captionMode
    : "balanced";

  return {
    baseUrl: normalizeBaseUrl(rawSettings.baseUrl),
    apiKey: String(rawSettings.apiKey || "").trim(),
    model: String(rawSettings.model || "").trim(),
    triggerToken: cleanToken(rawSettings.triggerToken),
    classToken: cleanToken(rawSettings.classToken),
    folderName: cleanFolder(rawSettings.folderName || "lora-dataset"),
    repeats: clampNumber(rawSettings.repeats, 1, 200, 10),
    captionMode,
    temperature: clampNumber(rawSettings.temperature, 0, 2, 0.35),
    maxTokens: Math.round(clampNumber(rawSettings.maxTokens, 2048, 8192, 2048)),
    timeoutSec: Math.round(clampNumber(rawSettings.timeoutSec, 15, 900, 180)),
    retryCount: Math.round(clampNumber(rawSettings.retryCount, 0, 5, 1)),
    customPrompt: String(rawSettings.customPrompt || "").trim().slice(0, 2500),
    promptVersion: CAPTION_PROMPT_VERSION
  };
}

export async function listModels({ baseUrl, apiKey }) {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: authHeaders(apiKey),
    timeoutMs: 10_000
  });

  const payload = await parseApiResponse(response);
  const models = Array.isArray(payload.data) ? payload.data : [];

  return models.map((model) => ({
    id: model.id,
    ownedBy: model.owned_by || model.ownedBy || "local"
  }));
}

export async function captionImage({ imagePath, mime, settings, signal }) {
  if (!settings.model) {
    throw httpError(400, "Select an LM Studio model before starting the job");
  }

  const image = await fs.readFile(imagePath);
  const prompt = buildCaptionPrompt(settings);
  const response = await fetchWithTimeout(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      ...authHeaders(settings.apiKey),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "system",
          content: buildCaptionSystemPrompt()
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mime};base64,${image.toString("base64")}`
              }
            }
          ]
        }
      ],
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      reasoning: {
        effort: "none"
      }
    }),
    timeoutMs: settings.timeoutSec * 1000,
    signal
  });

  const payload = await parseApiResponse(response);
  const content = extractCaptionFromModelMessage(payload.choices?.[0]?.message || {}, settings);
  const cleanedCaption = cleanCaptionContent(content);

  if (!cleanedCaption) {
    throw captionFailureError("LM Studio вернула пустой caption");
  }

  const caption = optimizeCaption(ensureCaptionPrefix(cleanedCaption, settings), settings);
  if (!hasCaptionDetails(caption, settings)) {
    throw captionFailureError("LM Studio не описала изображение и вернула только trigger phrase");
  }

  return caption;
}

export function buildCaptionPrompt(settings) {
  const trigger = [settings.triggerToken, settings.classToken].filter(Boolean).join(" ");
  const mode = CAPTION_MODES.get(settings.captionMode) || CAPTION_MODES.get("balanced");
  const triggerInstruction = trigger
    ? `First tag requirement: start with exactly "${trigger}", then a comma. Do not add any word before it or inside that first tag.`
    : "Do not invent a trigger token.";
  const formatExample = trigger
    ? `Output shape: ${trigger}, subject detail, pose or view, clothing/material/color, background, lighting, style or medium`
    : "Output shape: subject detail, pose or view, clothing/material/color, background, lighting, style or medium";
  const custom = settings.customPrompt
    ? `Additional project instruction from the user: ${settings.customPrompt}`
    : "";

  return [
    "Caption this image for a Stable Diffusion LoRA dataset.",
    "Task meaning: create a compact training description, not a chat answer and not a pretty generation prompt.",
    triggerInstruction,
    `Rules: ${CORE_LORA_CAPTION_RULES.join("; ")}.`,
    `Description quality: ${DESCRIPTION_QUALITY_RULES.join("; ")}.`,
    "Silent workflow: inspect image, choose visible facts, remove guesses/duplicates/boosters, then output one comma-separated line.",
    `Profile: ${mode.label}. ${mode.strategy}`,
    "Return final caption only.",
    `${formatExample}. Replace these placeholders with actual visible image facts.`,
    custom
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCaptionSystemPrompt() {
  return SYSTEM_CAPTION_PROMPT;
}

export function extractCaptionFromModelMessage(message, settings) {
  const content = message?.content;
  if (cleanCaptionContent(content)) return content;

  return extractCaptionFromReasoning(message?.reasoning_content, settings);
}

export function cleanCaptionContent(content) {
  let text = Array.isArray(content)
    ? content
        .map((part) => (typeof part === "string" ? part : part?.text || ""))
        .join(" ")
    : String(content || "");

  text = text
    .replace(/\r/g, "\n")
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```[a-z]*|```/gi, ""))
    .trim();

  const lines = text
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*]\s+|\d+[.)]\s+)/, ""))
    .filter(Boolean);

  text = (lines.length > 1 ? lines.join(", ") : lines[0] || text).trim();
  text = text
    .replace(/^caption\s*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/,+/g, ",")
    .replace(/^,\s*|\s*,$/g, "")
    .trim();

  return dedupeCaptionTags(
    splitCaptionTags(text)
      .map(normalizeCaptionTag)
      .filter(Boolean)
      .filter((tag) => !isLowValueCaptionTag(tag))
      .filter((tag) => !isInvalidCaptionTag(tag))
  ).join(", ");
}

export function ensureCaptionPrefix(caption, settings) {
  const prefix = [settings.triggerToken, settings.classToken].filter(Boolean).join(" ");
  const tags = splitCaptionTags(caption)
    .map(normalizeCaptionTag)
    .filter(Boolean)
    .filter((tag) => !isLowValueCaptionTag(tag))
    .filter((tag) => !isInvalidCaptionTag(tag));
  if (!prefix) return dedupeCaptionTags(tags).join(", ");
  if (!tags.length) return "";

  const prefixKey = normalizeTagKey(prefix);
  const triggerKey = normalizeTagKey(settings.triggerToken);
  const classKey = normalizeTagKey(settings.classToken);
  const cleanedTags = [];

  for (const [index, tag] of tags.entries()) {
    const tagKey = normalizeTagKey(tag);
    if (!tagKey || tagKey === prefixKey || tagKey === triggerKey || tagKey === classKey) continue;

    if (index === 0) {
      const prefixRemainder = stripLeadingPhrase(tag, prefix);
      if (prefixRemainder !== tag) {
        if (prefixRemainder) cleanedTags.push(prefixRemainder);
        continue;
      }

      const triggerRemainder = stripLeadingPhrase(tag, settings.triggerToken);
      if (triggerRemainder !== tag) {
        if (normalizeTagKey(triggerRemainder) !== classKey && triggerRemainder) {
          cleanedTags.push(triggerRemainder);
        }
        continue;
      }
    }

    cleanedTags.push(tag);
  }

  return dedupeCaptionTags([prefix, ...cleanedTags]).join(", ");
}

export function optimizeCaption(caption, settings = {}) {
  const prefix = [settings.triggerToken, settings.classToken].filter(Boolean).join(" ");
  const prefixKey = normalizeTagKey(prefix);
  const maxTags = CAPTION_TAG_LIMITS[settings.captionMode] || CAPTION_TAG_LIMITS.balanced;
  const tags = splitCaptionTags(caption)
    .map(normalizeCaptionTag)
    .filter(Boolean)
    .filter((tag) => !isLowValueCaptionTag(tag))
    .filter((tag) => !isInvalidCaptionTag(tag));

  const protectedPrefix = prefix && tags.some((tag) => normalizeTagKey(tag) === prefixKey) ? prefix : "";
  const detailTags = tags.filter((tag) => normalizeTagKey(tag) !== prefixKey);
  const compactDetails = compactNearDuplicateTags(detailTags);
  const limitedDetails = applyGroupLimits(compactDetails);
  const result = protectedPrefix ? [protectedPrefix, ...limitedDetails] : limitedDetails;

  return result.slice(0, maxTags).join(", ");
}

export function hasCaptionDetails(caption, settings) {
  return captionDetailCount(caption, settings) > 0;
}

function captionDetailCount(caption, settings) {
  const prefix = [settings.triggerToken, settings.classToken].filter(Boolean).join(" ");
  const prefixKey = normalizeTagKey(prefix);
  const triggerKey = normalizeTagKey(settings.triggerToken);
  const classKey = normalizeTagKey(settings.classToken);

  return splitCaptionTags(caption)
    .map(normalizeCaptionTag)
    .filter(Boolean)
    .filter((tag) => !isLowValueCaptionTag(tag))
    .filter((tag) => !isInvalidCaptionTag(tag))
    .filter((tag) => {
      const key = normalizeTagKey(tag);
      return key && key !== prefixKey && key !== triggerKey && key !== classKey;
    }).length;
}

function splitCaptionTags(caption) {
  return String(caption || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractCaptionFromReasoning(reasoningContent, settings) {
  const reasoning = String(reasoningContent || "");
  if (!reasoning.trim()) return "";

  const prefix = [settings.triggerToken, settings.classToken].filter(Boolean).join(" ");
  const lines = reasoning
    .split(/\n+/)
    .map((line) => line.trim().replace(/^(?:[-*>\s]+|\d+[.)]\s*)/, ""))
    .filter(Boolean);

  for (const line of lines.reverse()) {
    const candidate = reasoningLineCandidate(line, prefix);
    if (!candidate) continue;

    const caption = optimizeCaption(ensureCaptionPrefix(cleanCaptionContent(candidate), settings), settings);
    if (captionDetailCount(caption, settings) >= 4) return caption;
  }

  return "";
}

function reasoningLineCandidate(line, prefix) {
  if (/first tag requirement|output shape|captioning rules|the user wants|let'?s|rules:/i.test(line)) {
    return "";
  }

  const cleaned = line
    .replace(/^(?:final caption|caption|output|answer|draft\s*\d*)\s*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (!cleaned || /subject detail|pose or view|clothing\/material|trigger phrase/i.test(cleaned)) return "";

  if (prefix) {
    const index = cleaned.toLowerCase().indexOf(prefix.toLowerCase());
    if (index !== -1) return cleaned.slice(index);
  }

  return cleaned.includes(",") ? cleaned : "";
}

function normalizeCaptionTag(tag) {
  return String(tag || "")
    .trim()
    .replace(/^caption\s*:\s*/i, "")
    .replace(/^(?:an?\s+)?(?:image|photo|picture|photograph)\s+of\s+/i, "")
    .replace(/^["'`]+|["'`.]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*:\s*/g, ": ")
    .trim();
}

function dedupeCaptionTags(tags) {
  const seen = new Set();
  const result = [];

  for (const tag of tags) {
    const key = normalizeTagKey(tag);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }

  return result;
}

function compactNearDuplicateTags(tags) {
  const result = [];

  for (const tag of tags) {
    if (result.some((existing) => areNearDuplicateTags(existing, tag))) continue;
    result.push(tag);
  }

  return result;
}

function applyGroupLimits(tags) {
  const groupCounts = new Map();
  const result = [];

  for (const tag of tags) {
    const group = TAG_GROUP_RULES.find((rule) => rule.pattern.test(tag));
    if (group) {
      const current = groupCounts.get(group.name) || 0;
      if (current >= group.max) continue;
      groupCounts.set(group.name, current + 1);
    }

    result.push(tag);
  }

  return result;
}

function areNearDuplicateTags(left, right) {
  const leftTokens = tagTokens(left);
  const rightTokens = tagTokens(right);
  if (!leftTokens.length || !rightTokens.length) return false;

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const overlap = [...leftSet].filter((token) => rightSet.has(token)).length;
  const smaller = Math.min(leftSet.size, rightSet.size);
  const larger = Math.max(leftSet.size, rightSet.size);

  return overlap >= 2 && overlap / smaller >= 0.75 && larger - smaller <= 2;
}

function tagTokens(tag) {
  return normalizeTagKey(tag)
    .replace(/\b(?:pants)\b/g, "trousers")
    .replace(/\b(?:purse|handbag)\b/g, "bag")
    .replace(/\b(?:camel)\b/g, "tan")
    .split(/[^a-z0-9]+/i)
    .filter((token) => token && !["a", "an", "the", "and", "with", "in", "on", "of", "under"].includes(token));
}

function normalizeTagKey(tag) {
  return String(tag || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");
}

function isLowValueCaptionTag(tag) {
  return LOW_VALUE_TAGS.has(normalizeTagKey(tag));
}

function isInvalidCaptionTag(tag) {
  return INVALID_CAPTION_PATTERNS.some((pattern) => pattern.test(tag));
}

function captionFailureError(message) {
  return httpError(
    502,
    `${message}. Проверьте, что в LM Studio выбрана именно vision-модель с поддержкой изображений, например LLaVA, Qwen-VL, InternVL, MiniCPM-V, Pixtral, Molmo или другая multimodal/vision модель.`
  );
}

function stripLeadingPhrase(tag, phrase) {
  const cleanPhrase = String(phrase || "").trim();
  if (!cleanPhrase) return tag;

  const tagText = String(tag || "").trim();
  const lowerTag = tagText.toLowerCase();
  const lowerPhrase = cleanPhrase.toLowerCase();
  if (!lowerTag.startsWith(`${lowerPhrase} `)) return tag;

  return tagText.slice(cleanPhrase.length).trim();
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30_000);
  const abortFromParent = () => controller.abort(options.signal.reason);

  if (options.signal?.aborted) {
    controller.abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      const parentCancelled = Boolean(options.signal?.aborted);
      throw httpError(
        parentCancelled ? 499 : 504,
        parentCancelled ? "Запрос отменен" : "LM Studio не ответила за отведенное время"
      );
    }

    if (error instanceof TypeError) {
      const origin = new URL(url).origin;
      throw httpError(502, `LM Studio недоступна по адресу ${origin}. Запустите локальный сервер LM Studio и повторите попытку.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function parseApiResponse(response) {
  const text = await response.text();
  let payload = {};

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message =
      payload.error?.message ||
      payload.message ||
      text ||
      `LM Studio request failed with HTTP ${response.status}`;
    throw httpError(response.status, message, payload);
  }

  return payload;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function cleanToken(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function cleanFolder(value) {
  return String(value || "lora-dataset")
    .trim()
    .replace(/[^a-zA-Z0-9_. -]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "lora-dataset";
}
