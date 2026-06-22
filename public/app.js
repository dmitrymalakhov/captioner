const STORAGE_KEY = "captioner.settings.v2";
const FINAL_STATUSES = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;
const VISION_MODEL_HINT = /(vision|visual|vl\b|qwen.*vl|llava|bakllava|moondream|pixtral|internvl|minicpm.*v|cogvlm|molmo|ovis|paligemma|gemma.*vision|multimodal|mmproj)/i;

const PRESETS = {
  character: {
    classToken: "person",
    captionMode: "character",
    repeats: 10
  },
  style: {
    classToken: "style",
    captionMode: "style",
    repeats: 12
  },
  product: {
    classToken: "object",
    captionMode: "product",
    repeats: 8
  },
  general: {
    classToken: "subject",
    captionMode: "balanced",
    repeats: 10
  }
};

const state = {
  files: [],
  job: null,
  pollTimer: 0,
  uploading: false,
  lastModel: "",
  selectedPreset: "character",
  captionDrafts: new Map(),
  captionDirty: false,
  maxFiles: 500,
  maxUploadMb: 800,
  recentJobs: [],
  modelRefreshTimer: 0,
  expertMode: false
};

const els = {
  appShell: document.querySelector("#appShell"),
  expertMode: document.querySelector("#expertModeButton"),
  expertModeLabel: document.querySelector("#expertModeLabel"),
  baseUrl: document.querySelector("#baseUrlInput"),
  apiKey: document.querySelector("#apiKeyInput"),
  model: document.querySelector("#modelSelect"),
  refreshModels: document.querySelector("#refreshModelsButton"),
  connectionPill: document.querySelector("#connectionPill"),
  connectionHint: document.querySelector("#connectionHintText"),
  presetStrip: document.querySelector("#presetStrip"),
  subjectName: document.querySelector("#subjectNameInput"),
  triggerToken: document.querySelector("#triggerTokenInput"),
  classToken: document.querySelector("#classTokenInput"),
  repeats: document.querySelector("#repeatsInput"),
  folderName: document.querySelector("#folderNameInput"),
  captionMode: document.querySelector("#captionModeSelect"),
  temperature: document.querySelector("#temperatureInput"),
  temperatureValue: document.querySelector("#temperatureValue"),
  maxTokens: document.querySelector("#maxTokensInput"),
  timeout: document.querySelector("#timeoutInput"),
  retryCount: document.querySelector("#retryCountInput"),
  customPrompt: document.querySelector("#customPromptInput"),
  clear: document.querySelector("#clearButton"),
  download: document.querySelector("#downloadButton"),
  saveCaptions: document.querySelector("#saveCaptionsButton"),
  cancel: document.querySelector("#cancelButton"),
  start: document.querySelector("#startButton"),
  startLabel: document.querySelector("#startLabel"),
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#fileInput"),
  selectFiles: document.querySelector("#selectFilesButton"),
  emptySelect: document.querySelector("#emptySelectButton"),
  fileHint: document.querySelector("#fileHintText"),
  statusLine: document.querySelector("#statusLine"),
  statusDetail: document.querySelector("#statusDetail"),
  readinessPanel: document.querySelector("#readinessPanel"),
  modelReadyText: document.querySelector("#modelReadyText"),
  datasetReadyText: document.querySelector("#datasetReadyText"),
  filesReadyText: document.querySelector("#filesReadyText"),
  archiveReadyText: document.querySelector("#archiveReadyText"),
  progressBar: document.querySelector("#progressBar"),
  totalMetric: document.querySelector("#totalMetric"),
  doneMetric: document.querySelector("#doneMetric"),
  errorMetric: document.querySelector("#errorMetric"),
  recentJobPanel: document.querySelector("#recentJobPanel"),
  recentJobTitle: document.querySelector("#recentJobTitle"),
  recentJobDetail: document.querySelector("#recentJobDetail"),
  openRecentJob: document.querySelector("#openRecentJobButton"),
  datasetSummary: document.querySelector("#datasetSummary"),
  trainerPathText: document.querySelector("#trainerPathText"),
  zipPathText: document.querySelector("#zipPathText"),
  captionFormatText: document.querySelector("#captionFormatText"),
  queueSubtitle: document.querySelector("#queueSubtitle"),
  gallery: document.querySelector("#gallery"),
  emptyState: document.querySelector("#emptyState"),
  toast: document.querySelector("#toast")
};

init();

async function init() {
  loadPreferences();
  setActivePreset(state.selectedPreset);
  bindEvents();
  syncSubjectDerivedFields({ force: false });
  await loadHealth();
  await loadRecentJobs();
  render();
  await refreshModels(false);
}

function bindEvents() {
  els.refreshModels.addEventListener("click", () => refreshModels(true));
  els.selectFiles.addEventListener("click", () => els.fileInput.click());
  els.emptySelect.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => addFiles(els.fileInput.files));
  els.start.addEventListener("click", startJob);
  els.cancel.addEventListener("click", cancelJob);
  els.clear.addEventListener("click", clearAll);
  els.saveCaptions.addEventListener("click", saveCaptions);
  els.openRecentJob.addEventListener("click", openRecentJob);
  els.gallery.addEventListener("input", handleCaptionInput);
  els.expertMode.addEventListener("click", toggleExpertMode);

  for (const input of [els.baseUrl, els.apiKey]) {
    input.addEventListener("change", handleConnectionSettingsChange);
  }

  els.presetStrip.addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (!button) return;
    applyPreset(button.dataset.preset);
  });

  els.subjectName.addEventListener("input", () => {
    syncSubjectDerivedFields({ force: false });
    savePreferences();
    render();
  });

  els.temperature.addEventListener("input", () => {
    els.temperatureValue.textContent = Number(els.temperature.value).toFixed(2);
    savePreferences();
  });

  for (const input of [
    els.model,
    els.triggerToken,
    els.classToken,
    els.repeats,
    els.folderName,
    els.captionMode,
    els.maxTokens,
    els.timeout,
    els.retryCount,
    els.customPrompt
  ]) {
    input.addEventListener("change", () => {
      savePreferences();
      render();
    });
  }

  for (const eventName of ["dragenter", "dragover"]) {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.add("dragover");
    });
  }

  for (const eventName of ["dragleave", "drop"]) {
    els.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove("dragover");
    });
  }

  els.dropzone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
  document.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) addFiles(files);
  });
}

async function refreshModels(showFeedback) {
  setConnection("neutral", "Проверка");
  setConnectionHint("Проверяю список моделей в LM Studio...");
  els.refreshModels.disabled = true;

  try {
    const payload = await postJson("/api/models", {
      baseUrl: els.baseUrl.value,
      apiKey: els.apiKey.value
    });

    renderModels(payload.models || []);
    setConnection(payload.models?.length ? "good" : "warn", payload.models?.length ? "Подключено" : "Пусто");
    setConnectionHint(
      payload.models?.length
        ? `LM Studio подключена: ${payload.baseUrl}. Выберите vision-модель и запускайте разметку.`
        : `LM Studio ответила на ${payload.baseUrl}, но моделей нет. Загрузите vision-модель и нажмите проверку.`
    );
    if (showFeedback) showToast(`Найдено моделей: ${payload.models?.length || 0}`);
  } catch (error) {
    renderModels([]);
    setConnection("bad", "Нет связи");
    setConnectionHint(error.message);
    if (showFeedback) showToast(error.message);
  } finally {
    els.refreshModels.disabled = false;
    savePreferences();
    render();
  }
}

function handleConnectionSettingsChange() {
  savePreferences();
  render();
  window.clearTimeout(state.modelRefreshTimer);
  state.modelRefreshTimer = window.setTimeout(() => refreshModels(false), 150);
}

function toggleExpertMode() {
  state.expertMode = !state.expertMode;
  savePreferences();
  render();
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await parseJsonResponse(response);
    state.maxFiles = Number(health.maxFiles || state.maxFiles);
    state.maxUploadMb = Number(health.maxUploadMb || state.maxUploadMb);
    els.fileHint.textContent = `JPG, PNG, WebP, GIF, BMP, TIFF · до ${state.maxFiles} файлов · до ${state.maxUploadMb} MB`;
  } catch {
    els.fileHint.textContent = "JPG, PNG, WebP, GIF, BMP, TIFF";
  }
}

async function loadRecentJobs() {
  try {
    const response = await fetch("/api/jobs");
    const payload = await parseJsonResponse(response);
    state.recentJobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  } catch {
    state.recentJobs = [];
  }
}

function renderModels(models) {
  const previous = els.model.value || state.lastModel;
  els.model.innerHTML = "";

  if (!models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Модель не найдена";
    els.model.append(option);
    return;
  }

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = isLikelyVisionModel(model.id) ? model.id : `${model.id} · проверьте vision`;
    els.model.append(option);
  }

  if (previous && models.some((model) => model.id === previous)) {
    els.model.value = previous;
  }
}

function applyPreset(presetName) {
  const preset = PRESETS[presetName] || PRESETS.character;
  state.selectedPreset = PRESETS[presetName] ? presetName : "character";
  setActivePreset(state.selectedPreset);

  els.classToken.value = preset.classToken;
  els.captionMode.value = preset.captionMode;
  els.repeats.value = preset.repeats;
  syncSubjectDerivedFields({ force: false });
  savePreferences();
  render();
}

function setActivePreset(presetName) {
  state.selectedPreset = PRESETS[presetName] ? presetName : "character";
  for (const button of els.presetStrip.querySelectorAll("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === state.selectedPreset);
  }
}

function syncSubjectDerivedFields({ force }) {
  const subjectSlug = slugify(els.subjectName.value || els.classToken.value || "subject");
  const nextTrigger = subjectSlug ? `sks_${subjectSlug}` : "sks_subject";
  const nextFolder = subjectSlug ? `${subjectSlug}-lora-dataset` : "lora-dataset";

  if (force || shouldAutoReplaceTrigger(els.triggerToken.value)) {
    els.triggerToken.value = nextTrigger;
  }

  if (force || shouldAutoReplaceFolder(els.folderName.value)) {
    els.folderName.value = nextFolder;
  }
}

function ensureQuickDefaults() {
  if (!els.classToken.value.trim()) {
    els.classToken.value = PRESETS[state.selectedPreset]?.classToken || "subject";
  }

  syncSubjectDerivedFields({ force: !els.triggerToken.value.trim() || !els.folderName.value.trim() });
}

function setConnection(kind, text) {
  els.connectionPill.className = `status-pill ${kind}`;
  els.connectionPill.textContent = text;
}

function setConnectionHint(text) {
  els.connectionHint.textContent = text;
}

function addFiles(fileList) {
  if (state.job && !FINAL_STATUSES.has(state.job.status)) {
    showToast("Дождитесь завершения текущей очереди");
    return;
  }

  if (state.job && FINAL_STATUSES.has(state.job.status)) {
    if (!confirmDiscardCaptionChanges()) return;
    resetJobState();
  }

  const files = [...fileList].filter((file) => file.type.startsWith("image/") || IMAGE_EXTENSIONS.test(file.name));
  if (!files.length) {
    showToast("Поддерживаются только изображения");
    return;
  }

  const availableSlots = Math.max(0, state.maxFiles - state.files.length);
  if (availableSlots === 0) {
    showToast(`Лимит ${state.maxFiles} изображений на один датасет`);
    return;
  }

  const existingKeys = new Set(state.files.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
  let added = 0;
  for (const file of files) {
    if (added >= availableSlots) break;
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    state.files.push({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      status: "ready"
    });
    added += 1;
  }

  if (files.length > availableSlots) {
    showToast(`Добавлено ${availableSlots} файлов из ${files.length}. Лимит: ${state.maxFiles}`);
  }

  if (selectedUploadSizeMb() > state.maxUploadMb) {
    showToast(`Размер выбранных файлов больше лимита ${state.maxUploadMb} MB`);
  }

  els.fileInput.value = "";
  render();
}

async function startJob() {
  if (!state.files.length) {
    showToast("Добавьте изображения");
    return;
  }

  ensureQuickDefaults();
  const settings = collectSettings();
  if (!settings.model) {
    showToast("Выберите модель LM Studio");
    return;
  }

  if (!settings.subjectName) {
    showToast("Укажите название LoRA");
    return;
  }

  if (!settings.triggerToken) {
    showToast("Укажите название LoRA или trigger token");
    return;
  }

  if (selectedUploadSizeMb() > state.maxUploadMb) {
    showToast(`Уменьшите набор файлов: лимит загрузки ${state.maxUploadMb} MB`);
    return;
  }

  state.uploading = true;
  render();
  savePreferences();

  const form = new FormData();
  form.append("settings", JSON.stringify(settings));
  for (const item of state.files) {
    form.append("images", item.file, item.file.name);
  }

  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      body: form
    });
    const payload = await parseJsonResponse(response);
    releaseLocalPreviews();
    state.files = [];
    state.captionDrafts.clear();
    state.captionDirty = false;
    state.job = payload;
    pollJob();
    state.pollTimer = window.setInterval(pollJob, 1000);
  } catch (error) {
    showToast(error.message);
  } finally {
    state.uploading = false;
    render();
  }
}

async function pollJob() {
  if (!state.job) return;

  try {
    const response = await fetch(`/api/jobs/${state.job.id}`);
    state.job = await parseJsonResponse(response);
    render();

    if (FINAL_STATUSES.has(state.job.status)) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = 0;
      if (state.job.archiveReady) {
        showToast("Архив готов");
      }
      loadRecentJobs().then(render).catch(() => {});
    }
  } catch (error) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = 0;
    showToast(error.message);
  }
}

async function openRecentJob() {
  const recentJob = getBestRecentJob();
  if (!recentJob) return;
  if (!confirmDiscardCaptionChanges()) return;

  releaseLocalPreviews();
  state.files = [];
  resetJobState();

  try {
    const response = await fetch(`/api/jobs/${recentJob.id}`);
    state.job = await parseJsonResponse(response);
    render();
  } catch (error) {
    showToast(error.message);
    await loadRecentJobs();
    render();
  }
}

async function cancelJob() {
  if (!state.job || FINAL_STATUSES.has(state.job.status)) return;

  els.cancel.disabled = true;
  try {
    const response = await fetch(`/api/jobs/${state.job.id}/cancel`, {
      method: "POST"
    });
    state.job = await parseJsonResponse(response);
    render();
    showToast("Отмена запрошена");
  } catch (error) {
    showToast(error.message);
    render();
  }
}

async function saveCaptions() {
  if (!state.job || !state.captionDirty) return;

  els.saveCaptions.disabled = true;
  const captions = state.job.items
    .filter((item) => item.status === "done")
    .map((item) => ({
      id: item.id,
      caption: state.captionDrafts.get(item.id) ?? item.caption
    }));

  try {
    const response = await fetch(`/api/jobs/${state.job.id}/captions`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ captions })
    });
    const payload = await parseJsonResponse(response);
    state.job = payload;
    state.captionDrafts.clear();
    state.captionDirty = false;
    render();
    showToast(payload.changed ? "Правки сохранены, архив пересобран" : "Изменений нет");
  } catch (error) {
    showToast(error.message);
    updateSaveCaptionsState();
  }
}

async function clearAll() {
  if (state.job && !FINAL_STATUSES.has(state.job.status)) {
    const confirmed = window.confirm("Отменить текущую очередь?");
    if (!confirmed) return;
    await cancelJob();
    return;
  }

  if (!confirmDiscardCaptionChanges()) return;

  const jobId = state.job?.id;
  resetJobState();
  releaseLocalPreviews();
  state.files = [];
  render();

  if (jobId) {
    fetch(`/api/jobs/${jobId}`, { method: "DELETE" })
      .then(() => loadRecentJobs())
      .then(render)
      .catch(() => {});
  }
}

function resetJobState() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = 0;
  }
  state.job = null;
  state.captionDrafts.clear();
  state.captionDirty = false;
}

function render() {
  const stats = getStats();
  const hasItems = Boolean(state.job?.items?.length || state.files.length);
  const requirements = getStartRequirements();

  renderExpertMode();
  els.totalMetric.textContent = String(stats.total);
  els.doneMetric.textContent = String(stats.done);
  els.errorMetric.textContent = String(stats.errors);
  els.progressBar.style.width = `${stats.progress}%`;
  els.queueSubtitle.textContent = hasItems ? `${stats.total} файлов` : "Нет файлов";
  els.temperatureValue.textContent = Number(els.temperature.value).toFixed(2);
  els.startLabel.textContent = state.files.length ? `Разметить ${state.files.length}` : "Разметить";

  if (state.uploading) {
    els.statusLine.textContent = "Загрузка изображений";
    els.statusDetail.textContent = "Файлы отправляются на локальный сервер";
  } else if (state.job) {
    els.statusLine.textContent = statusTitle(state.job.status);
    els.statusDetail.textContent = statusDetail(state.job);
  } else if (state.files.length) {
    els.statusLine.textContent = "Файлы готовы";
    els.statusDetail.textContent = requirements.ready ? "Можно запускать разметку" : `Нужно: ${requirements.missing.join(", ")}`;
  } else {
    els.statusLine.textContent = "Файлы не выбраны";
    els.statusDetail.textContent = requirements.missing.length ? `Нужно: ${requirements.missing.join(", ")}` : "Готово к загрузке изображений";
  }

  els.start.disabled = state.uploading || !requirements.ready || Boolean(state.job && !FINAL_STATUSES.has(state.job.status));
  els.cancel.hidden = !state.job || FINAL_STATUSES.has(state.job.status);
  els.cancel.disabled = Boolean(state.job?.cancelRequested);

  renderReadiness(requirements);
  renderRecentJob();
  renderDatasetSummary();
  renderGallery();
  updateSaveCaptionsState();
}

function renderExpertMode() {
  els.appShell.classList.toggle("expert-enabled", state.expertMode);
  els.expertMode.setAttribute("aria-pressed", state.expertMode ? "true" : "false");
  els.expertModeLabel.textContent = state.expertMode ? "Простой режим" : "Расширенные настройки";
}

function renderRecentJob() {
  const recentJob = getBestRecentJob();
  const visible = Boolean(recentJob && !state.job && !state.files.length);
  els.recentJobPanel.hidden = !visible;
  if (!visible) return;

  els.recentJobTitle.textContent = recentJob.settings?.folderName || recentJob.dataset?.rootName || "Готовый датасет";
  els.recentJobDetail.textContent = `${statusTitle(recentJob.status)} · ${recentJob.processed || 0}/${recentJob.total || 0} изображений`;
}

function getBestRecentJob() {
  return state.recentJobs.find((job) => job.archiveReady) || state.recentJobs[0] || null;
}

function getStartRequirements() {
  const modelReady = Boolean(els.model.value);
  const datasetReady = Boolean(els.subjectName.value.trim());
  const filesReady = state.files.length > 0;
  const busy = Boolean(state.job && !FINAL_STATUSES.has(state.job.status));
  const missing = [];

  if (!modelReady) missing.push("модель");
  if (!datasetReady) missing.push("название LoRA");
  if (!filesReady) missing.push("изображения");

  return {
    modelReady,
    datasetReady,
    filesReady,
    archiveReady: Boolean(state.job?.archiveReady && !state.captionDirty),
    busy,
    ready: modelReady && datasetReady && filesReady && !busy,
    missing
  };
}

function renderReadiness(requirements) {
  setReadiness(
    "model",
    requirements.modelReady,
    requirements.modelReady ? modelReadinessText(els.model.value) : "Не выбрана"
  );
  setReadiness(
    "dataset",
    requirements.datasetReady,
    requirements.datasetReady ? `${els.triggerToken.value || "trigger"} ${els.classToken.value || ""}`.trim() : "Нет названия"
  );
  setReadiness(
    "files",
    requirements.filesReady || Boolean(state.job?.items?.length),
    state.job?.items?.length
      ? `${state.job.items.length} изображений`
      : requirements.filesReady
        ? `${state.files.length} изображений`
        : "Нет изображений"
  );
  setReadiness(
    "archive",
    requirements.archiveReady,
    requirements.archiveReady
      ? "Готов к скачиванию"
      : state.captionDirty
        ? "Сохраните правки"
        : state.job
          ? statusTitle(state.job.status)
          : "Ожидает разметку"
  );
}

function modelReadinessText(modelId) {
  if (!modelId) return "Не выбрана";
  return isLikelyVisionModel(modelId) ? modelId : `${modelId} · возможно не vision`;
}

function setReadiness(key, ready, text) {
  const item = els.readinessPanel.querySelector(`[data-ready-key="${key}"]`);
  item.classList.toggle("ready", Boolean(ready));
  item.classList.toggle("pending", !ready);

  if (key === "model") els.modelReadyText.textContent = text;
  if (key === "dataset") els.datasetReadyText.textContent = text;
  if (key === "files") els.filesReadyText.textContent = text;
  if (key === "archive") els.archiveReadyText.textContent = text;
}

function renderDatasetSummary() {
  const layout = state.job?.dataset || buildLocalDatasetLayout(collectSettings());
  els.datasetSummary.hidden = !(state.job || state.files.length || els.subjectName.value.trim());
  els.trainerPathText.textContent = layout.trainParentPath;
  els.zipPathText.textContent = `${layout.trainingPath}/0001_image + ${layout.captionExtension}`;
  els.captionFormatText.textContent = "dataset.toml, captions.csv, captions.jsonl";
}

function renderGallery() {
  const canEdit = canEditCaptions();
  const items = state.job?.items?.length
    ? state.job.items.map((item) => ({
        id: item.id,
        name: item.originalName,
        size: item.size,
        src: item.previewUrl,
        status: item.status,
        caption: item.caption,
        error: item.error,
        edited: Boolean(item.editedAt),
        attempts: item.attempts || 0
      }))
    : state.files.map((item) => ({
        id: item.id,
        name: item.file.name,
        size: item.file.size,
        src: item.previewUrl,
        status: item.status,
        caption: "",
        error: "",
        edited: false,
        attempts: 0
      }));

  els.gallery.classList.toggle("hidden", !items.length);
  els.emptyState.classList.toggle("hidden", Boolean(items.length));
  els.gallery.innerHTML = items.map((item) => renderCard(item, canEdit)).join("");
}

function renderCard(item, canEdit) {
  const draft = state.captionDrafts.get(item.id);
  const captionValue = draft ?? item.caption;
  const dirty = draft !== undefined && draft !== item.caption;
  const retryHint = item.attempts > 1 && item.status !== "done" ? `, попытка ${item.attempts}` : "";
  const message = item.error || item.caption || `${localStatusText(item.status)}${retryHint}`;
  const messageClass = item.error ? "error" : item.caption ? "" : "muted";
  const editable = canEdit && item.status === "done";

  return `
    <article class="image-card status-${escapeAttribute(item.status)} ${item.edited || dirty ? "edited" : ""}">
      <div class="thumb">
        <img src="${escapeAttribute(item.src)}" alt="" loading="lazy">
        <span class="card-status">${escapeHtml(dirty ? "Изменено" : item.edited ? "Правка" : cardStatus(item.status))}</span>
      </div>
      <div class="card-body">
        <div class="file-row">
          <strong title="${escapeAttribute(item.name)}">${escapeHtml(item.name)}</strong>
          <span>${formatBytes(item.size)}</span>
        </div>
        ${
          editable
            ? `<textarea class="caption-editor" data-caption-id="${escapeAttribute(item.id)}" spellcheck="false">${escapeHtml(captionValue)}</textarea>`
            : `<p class="caption-text ${messageClass}">${escapeHtml(message)}</p>`
        }
      </div>
    </article>
  `;
}

function handleCaptionInput(event) {
  const input = event.target.closest("[data-caption-id]");
  if (!input) return;

  state.captionDrafts.set(input.dataset.captionId, input.value);
  state.captionDirty = hasCaptionChanges();
  updateSaveCaptionsState();
}

function updateSaveCaptionsState() {
  const canEdit = canEditCaptions();
  els.saveCaptions.hidden = !canEdit;
  els.saveCaptions.disabled = !canEdit || !state.captionDirty;

  const downloadReady = Boolean(state.job?.archiveReady) && !state.captionDirty;
  els.download.classList.toggle("disabled", !downloadReady);
  els.download.setAttribute("aria-disabled", downloadReady ? "false" : "true");
  els.download.href = downloadReady ? state.job.downloadUrl : "#";
}

function canEditCaptions() {
  return Boolean(
    state.job?.archiveReady &&
      FINAL_STATUSES.has(state.job.status) &&
      state.job.items.some((item) => item.status === "done")
  );
}

function confirmDiscardCaptionChanges() {
  if (!state.captionDirty) return true;
  return window.confirm("Есть несохраненные правки подписей. Сбросить их?");
}

function hasCaptionChanges() {
  if (!state.job) return false;
  return state.job.items.some((item) => state.captionDrafts.has(item.id) && state.captionDrafts.get(item.id) !== item.caption);
}

function getStats() {
  if (state.job) {
    const done = state.job.items.filter((item) => item.status === "done").length;
    const errors = state.job.items.filter((item) => item.status === "error").length;
    const total = state.job.total || state.job.items.length;
    const processed = state.job.processed || done + errors;
    return {
      total,
      done,
      errors,
      progress: total ? Math.round((processed / total) * 100) : 0
    };
  }

  return {
    total: state.files.length,
    done: 0,
    errors: 0,
    progress: 0
  };
}

function selectedUploadSizeMb() {
  const bytes = state.files.reduce((sum, item) => sum + item.file.size, 0);
  return bytes / 1024 / 1024;
}

function collectSettings() {
  return {
    baseUrl: els.baseUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value,
    subjectName: els.subjectName.value.trim(),
    triggerToken: els.triggerToken.value.trim(),
    classToken: els.classToken.value.trim(),
    repeats: Number(els.repeats.value),
    folderName: els.folderName.value.trim(),
    captionMode: els.captionMode.value,
    temperature: Number(els.temperature.value),
    maxTokens: Number(els.maxTokens.value),
    timeoutSec: Number(els.timeout.value),
    retryCount: Number(els.retryCount.value),
    customPrompt: els.customPrompt.value.trim()
  };
}

function buildLocalDatasetLayout(settings) {
  const rootName = safeName(settings.folderName || "lora-dataset", "lora-dataset");
  const tokenPhrase = [settings.triggerToken, settings.classToken].filter(Boolean).join(" ");
  const subjectName = safeName(tokenPhrase.replace(/\s+/g, "-") || settings.classToken || "captioned-images", "captioned-images");
  const repeats = Math.max(1, Math.round(Number(settings.repeats) || 10));
  const trainingFolder = `${repeats}_${subjectName}`;

  return {
    rootName,
    tokenPhrase,
    repeats,
    trainingFolder,
    trainParentPath: `${rootName}/train`,
    trainingPath: `${rootName}/train/${trainingFolder}`,
    captionExtension: ".txt"
  };
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    for (const [key, element] of Object.entries({
      baseUrl: els.baseUrl,
      apiKey: els.apiKey,
      subjectName: els.subjectName,
      triggerToken: els.triggerToken,
      classToken: els.classToken,
      repeats: els.repeats,
      folderName: els.folderName,
      captionMode: els.captionMode,
      temperature: els.temperature,
      maxTokens: els.maxTokens,
      timeoutSec: els.timeout,
      retryCount: els.retryCount,
      customPrompt: els.customPrompt
    })) {
      if (saved[key] !== undefined) element.value = saved[key];
    }
    state.lastModel = saved.model || "";
    state.selectedPreset = PRESETS[saved.selectedPreset] ? saved.selectedPreset : state.selectedPreset;
    state.expertMode = Boolean(saved.expertMode);
    els.maxTokens.value = String(Math.min(8192, Math.max(2048, Number(els.maxTokens.value) || 2048)));
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function savePreferences() {
  const settings = collectSettings();
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...settings,
      selectedPreset: state.selectedPreset,
      expertMode: state.expertMode,
      apiKey: settings.apiKey ? settings.apiKey : ""
    })
  );
  state.lastModel = settings.model;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return parseJsonResponse(response);
}

async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function releaseLocalPreviews() {
  for (const item of state.files) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

function statusTitle(status) {
  return (
    {
      queued: "Очередь создана",
      running: "Разметка выполняется",
      completed: "Разметка завершена",
      completed_with_errors: "Готово с ошибками",
      failed: "Разметка не выполнена",
      cancelled: "Разметка отменена"
    }[status] || "Обработка"
  );
}

function statusDetail(job) {
  if (state.captionDirty) return "Сохраните правки перед скачиванием архива";
  if (job.status === "completed") return "Проверьте подписи или скачайте архив";
  if (job.status === "completed_with_errors") return "Архив содержит успешно размеченные изображения";
  if (job.status === "failed") return job.error || "LM Studio не вернул ни одной подписи";
  if (job.status === "cancelled") return "Очередь остановлена";
  if (job.cancelRequested) return "Останавливаю текущий запрос к LM Studio";
  return `${job.processed || 0} из ${job.total || 0} обработано`;
}

function isLikelyVisionModel(modelId) {
  return VISION_MODEL_HINT.test(String(modelId || ""));
}

function cardStatus(status) {
  return (
    {
      ready: "Готово",
      queued: "В очереди",
      processing: "Сейчас",
      done: "Caption",
      error: "Ошибка",
      cancelled: "Отменено"
    }[status] || status
  );
}

function localStatusText(status) {
  return (
    {
      ready: "Ожидает запуска",
      queued: "Ожидает обработки",
      processing: "LM Studio генерирует подпись",
      done: "Caption готов",
      error: "Ошибка обработки",
      cancelled: "Отменено"
    }[status] || ""
  );
}

function shouldAutoReplaceTrigger(value) {
  const text = value.trim();
  return !text || text === "sks_subject" || /^sks_[a-z0-9_-]+$/i.test(text);
}

function shouldAutoReplaceFolder(value) {
  const text = value.trim();
  return !text || text === "lora-dataset" || /-lora-dataset$/i.test(text);
}

function slugify(value) {
  const transliterated = transliterate(String(value || "").toLowerCase());
  return transliterated
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 42);
}

function safeName(value, fallback) {
  return (
    String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 80) || fallback
  );
}

function transliterate(value) {
  const map = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya"
  };

  return value.replace(/[а-яё]/g, (letter) => map[letter] ?? letter);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("visible"), 3200);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
