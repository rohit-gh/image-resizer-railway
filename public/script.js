// ── DOM refs ─────────────────────────────────────────────────────────────────

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileName = document.getElementById("file-name");
const scaleControl = document.getElementById("scale-control");
const scaleRange = document.getElementById("scale-range");
const scaleValue = document.getElementById("scale-value");
const optimiseBtn = document.getElementById("optimise-btn");
const loader = document.getElementById("loader");
const resultSection = document.getElementById("result-section");
const resultStats = document.getElementById("result-stats");
const downloadBtn = document.getElementById("download-btn");
const historyList = document.getElementById("history-list");

let selectedFile = null;

// ── Tab Switching ────────────────────────────────────────────────────────────

const tabBtns = document.querySelectorAll(".tab-btn");
const tabSingle = document.getElementById("tab-single");
const tabBulk = document.getElementById("tab-bulk");

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    tabBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    if (tab === "single") {
      tabSingle.classList.remove("tab-hidden");
      tabBulk.classList.add("tab-hidden");
    } else {
      tabSingle.classList.add("tab-hidden");
      tabBulk.classList.remove("tab-hidden");
      loadBulkHistory();
    }
  });
});

// ── File selection ───────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|svg|tiff?|heic|heif|avif)$/i;

function isImageFile(file) {
  if (file.type.startsWith("image/")) return true;
  // iOS Safari often returns an empty file.type for HEIC/HEIF photos —
  // fall back to checking the file extension.
  if (!file.type && IMAGE_EXTENSIONS.test(file.name)) return true;
  return false;
}

function handleFile(file) {
  if (!file || !isImageFile(file)) return;
  selectedFile = file;
  fileName.textContent = `${file.name} (${formatBytes(file.size)})`;
  optimiseBtn.disabled = false;
  resultSection.hidden = true;
}

dropZone.addEventListener("click", (e) => {
  // Avoid double-triggering on iOS: if the click landed on the <label> or
  // its children the browser already opens the file picker natively.
  if (e.target.closest('label[for="file-input"]')) return;
  // iOS Safari may not fire `change` if the user selects the same file again.
  // Clearing the value ensures a new selection always triggers.
  fileInput.value = "";
  fileInput.click();
});

function tryHandlePickedFile(attempt = 0) {
  const file = fileInput.files && fileInput.files[0];
  if (file) {
    handleFile(file);
    return;
  }

  // iOS Safari can momentarily report an empty FileList right after returning
  // from the picker. Retry a couple of times on the next frame.
  if (attempt < 3) {
    requestAnimationFrame(() => tryHandlePickedFile(attempt + 1));
  }
}

fileInput.addEventListener("change", () => {
  tryHandlePickedFile();
});

// Some mobile browsers are more reliable with `input` than `change`.
fileInput.addEventListener("input", () => {
  tryHandlePickedFile();
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  handleFile(e.dataTransfer.files[0]);
});

// ── Mode selection ───────────────────────────────────────────────────────────

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const mode = getMode();
    scaleControl.classList.toggle("visible", mode !== "webp");
  });
});

scaleRange.addEventListener("input", () => {
  scaleValue.textContent = scaleRange.value;
});

// ── Optimise ─────────────────────────────────────────────────────────────────

optimiseBtn.addEventListener("click", async () => {
  if (!selectedFile) return;

  const mode = getMode();
  const scale = scaleRange.value;

  const formData = new FormData();
  formData.append("image", selectedFile);
  formData.append("mode", mode);
  formData.append("scale", scale);

  loader.hidden = false;
  resultSection.hidden = true;

  try {
    const res = await fetch("/optimise", {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Optimisation failed");
    }

    const originalSize = parseInt(res.headers.get("X-Original-Size") || "0", 10);
    const optimisedSize = parseInt(res.headers.get("X-Optimised-Size") || "0", 10);
    const saved = originalSize - optimisedSize;
    const pct = originalSize > 0 ? Math.round((saved / originalSize) * 100) : 0;

    resultStats.innerHTML = `
      <div class="stat">
        <span class="stat__label">Original</span>
        <span class="stat__value">${formatBytes(originalSize)}</span>
      </div>
      <div class="stat">
        <span class="stat__label">Optimised</span>
        <span class="stat__value">${formatBytes(optimisedSize)}</span>
      </div>
      <div class="stat">
        <span class="stat__label">Saved</span>
        <span class="stat__value stat__value--success">${pct}%</span>
      </div>
    `;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="(.+)"/);
    const downloadName = match ? match[1] : "optimised";

    downloadBtn.href = url;
    downloadBtn.download = downloadName;
    resultSection.hidden = false;

    // Refresh history
    loadHistory();
  } catch (err) {
    alert(err.message);
  } finally {
    loader.hidden = true;
  }
});

// ── History ──────────────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch("/history");
    const data = await res.json();

    if (!data.length) {
      historyList.innerHTML = '<p class="history-empty">No optimisations yet.</p>';
      return;
    }

    historyList.innerHTML = data
      .map(
        (entry) => `
        <div class="history-item">
          <div>
            <div class="history-item__name">${escapeHtml(entry.originalName)}</div>
            <div class="history-item__meta">
              ${formatBytes(entry.originalSize)} → ${formatBytes(entry.optimisedSize)}
              &nbsp;
              <span class="history-item__badge">${entry.mode}${entry.scale ? " " + entry.scale + "%" : ""}</span>
              &nbsp;·&nbsp;
              ${timeAgo(entry.timestamp)}
            </div>
          </div>
          <a class="history-item__download" href="/output/${encodeURIComponent(entry.outputFilename)}" download>Download</a>
        </div>`
      )
      .join("");
  } catch {
    // silent fail
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  BULK UPLOAD
// ══════════════════════════════════════════════════════════════════════════════

const bulkDropZone = document.getElementById("bulk-drop-zone");
const bulkFileInput = document.getElementById("bulk-file-input");
const bulkFileSummary = document.getElementById("bulk-file-summary");
const bulkValidationMsg = document.getElementById("bulk-validation-msg");
const bulkFileListEl = document.getElementById("bulk-file-list");
const bulkScaleRange = document.getElementById("bulk-scale-range");
const bulkScaleValue = document.getElementById("bulk-scale-value");
const bulkQualityRange = document.getElementById("bulk-quality-range");
const bulkQualityValue = document.getElementById("bulk-quality-value");
const bulkOptimiseBtn = document.getElementById("bulk-optimise-btn");
const bulkProgressSection = document.getElementById("bulk-progress-section");
const bulkProgressFill = document.getElementById("bulk-progress-fill");
const bulkProgressText = document.getElementById("bulk-progress-text");
const bulkProgressCurrent = document.getElementById("bulk-progress-current");
const bulkResultSection = document.getElementById("bulk-result-section");
const bulkResultStats = document.getElementById("bulk-result-stats");
const bulkDownloadBtn = document.getElementById("bulk-download-btn");
const bulkHistoryList = document.getElementById("bulk-history-list");

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 100;

let bulkFiles = []; // Array of File objects

// ── Bulk sliders ─────────────────────────────────────────────────────────────

bulkScaleRange.addEventListener("input", () => {
  bulkScaleValue.textContent = bulkScaleRange.value;
});

bulkQualityRange.addEventListener("input", () => {
  bulkQualityValue.textContent = bulkQualityRange.value;
});

// ── Bulk file selection ──────────────────────────────────────────────────────

function validateAndSetBulkFiles(files) {
  bulkValidationMsg.textContent = "";
  bulkValidationMsg.className = "bulk-validation-msg";

  const images = Array.from(files).filter(isImageFile);

  if (images.length === 0) {
    bulkValidationMsg.textContent = "No valid image files selected.";
    bulkValidationMsg.classList.add("error");
    return;
  }

  if (images.length > MAX_FILES) {
    bulkValidationMsg.textContent = `Too many files! Maximum ${MAX_FILES} allowed. You selected ${images.length}.`;
    bulkValidationMsg.classList.add("error");
    return;
  }

  const oversized = images.filter((f) => f.size > MAX_FILE_SIZE);
  if (oversized.length > 0) {
    bulkValidationMsg.textContent = `${oversized.length} file(s) exceed 10 MB: ${oversized.map((f) => f.name).join(", ")}`;
    bulkValidationMsg.classList.add("error");
    return;
  }

  bulkFiles = images;
  renderBulkFileList();
  updateBulkSummary();
}

function updateBulkSummary() {
  if (bulkFiles.length === 0) {
    bulkFileSummary.textContent = "";
    bulkOptimiseBtn.disabled = true;
    return;
  }
  const totalSize = bulkFiles.reduce((s, f) => s + f.size, 0);
  bulkFileSummary.textContent = `${bulkFiles.length} file${bulkFiles.length > 1 ? "s" : ""} · ${formatBytes(totalSize)}`;
  bulkOptimiseBtn.disabled = false;
}

function renderBulkFileList() {
  if (bulkFiles.length === 0) {
    bulkFileListEl.innerHTML = "";
    return;
  }

  bulkFileListEl.innerHTML = bulkFiles
    .map(
      (file, i) => `
      <div class="bulk-file-item">
        <span class="bulk-file-item__name">${escapeHtml(file.name)}</span>
        <span class="bulk-file-item__size">${formatBytes(file.size)}</span>
        <button class="bulk-file-item__remove" data-index="${i}" title="Remove">&times;</button>
      </div>`
    )
    .join("");

  // Remove buttons
  bulkFileListEl.querySelectorAll(".bulk-file-item__remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.index, 10);
      bulkFiles.splice(idx, 1);
      renderBulkFileList();
      updateBulkSummary();
    });
  });
}

bulkDropZone.addEventListener("click", (e) => {
  if (e.target.closest('label[for="bulk-file-input"]')) return;
  bulkFileInput.value = "";
  bulkFileInput.click();
});

bulkFileInput.addEventListener("change", () => {
  if (bulkFileInput.files && bulkFileInput.files.length > 0) {
    validateAndSetBulkFiles(bulkFileInput.files);
  }
});

bulkFileInput.addEventListener("input", () => {
  if (bulkFileInput.files && bulkFileInput.files.length > 0) {
    validateAndSetBulkFiles(bulkFileInput.files);
  }
});

bulkDropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  bulkDropZone.classList.add("drag-over");
});

bulkDropZone.addEventListener("dragleave", () => {
  bulkDropZone.classList.remove("drag-over");
});

bulkDropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  bulkDropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length > 0) {
    validateAndSetBulkFiles(e.dataTransfer.files);
  }
});

// ── Bulk Optimise ────────────────────────────────────────────────────────────

bulkOptimiseBtn.addEventListener("click", async () => {
  if (bulkFiles.length === 0) return;

  const scale = bulkScaleRange.value;
  const quality = bulkQualityRange.value;

  const formData = new FormData();
  formData.append("scale", scale);
  formData.append("quality", quality);
  bulkFiles.forEach((file) => formData.append("images", file));

  // Show progress, hide result
  bulkProgressSection.hidden = false;
  bulkResultSection.hidden = true;
  bulkOptimiseBtn.disabled = true;
  bulkProgressFill.style.width = "0%";
  bulkProgressText.textContent = `0 / ${bulkFiles.length} files`;
  bulkProgressCurrent.textContent = "";

  try {
    const res = await fetch("/bulk-optimise", {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Bulk upload failed");
    }

    const { taskId } = await res.json();

    // Connect SSE
    connectBulkSSE(taskId);
  } catch (err) {
    alert(err.message);
    bulkProgressSection.hidden = true;
    bulkOptimiseBtn.disabled = false;
  }
});

function connectBulkSSE(taskId) {
  const evtSource = new EventSource(`/bulk-events/${taskId}`);

  evtSource.addEventListener("status", (e) => {
    const data = JSON.parse(e.data);
    if (data.status === "completed") {
      showBulkResult(data, taskId);
      evtSource.close();
    } else if (data.status === "failed") {
      alert("Bulk processing failed.");
      bulkProgressSection.hidden = true;
      bulkOptimiseBtn.disabled = false;
      evtSource.close();
    } else {
      bulkProgressFill.style.width = `${data.progress}%`;
      bulkProgressText.textContent = `${data.processedCount} / ${data.totalCount} files`;
    }
  });

  evtSource.addEventListener("progress", (e) => {
    const data = JSON.parse(e.data);
    bulkProgressFill.style.width = `${data.progress}%`;
    bulkProgressText.textContent = `${data.processedCount} / ${data.totalCount} files`;
    bulkProgressCurrent.textContent = `Processing: ${escapeHtml(data.currentFile)}`;
  });

  evtSource.addEventListener("completed", (e) => {
    const data = JSON.parse(e.data);
    showBulkResult(data, taskId);
    evtSource.close();
  });

  evtSource.addEventListener("error", (e) => {
    // If SSE had a data payload, try to parse it
    if (e.data) {
      const data = JSON.parse(e.data);
      alert(`Bulk processing error: ${data.error}`);
    }
    bulkProgressSection.hidden = true;
    bulkOptimiseBtn.disabled = false;
    evtSource.close();
  });
}

function showBulkResult(data, taskId) {
  bulkProgressSection.hidden = true;

  const totalInputSize = data.totalInputSize;
  const zipSize = data.zipSize;
  const saved = totalInputSize - zipSize;
  const pct = totalInputSize > 0 ? Math.round((saved / totalInputSize) * 100) : 0;

  bulkResultStats.innerHTML = `
    <div class="stat">
      <span class="stat__label">Total Input</span>
      <span class="stat__value">${formatBytes(totalInputSize)}</span>
    </div>
    <div class="stat">
      <span class="stat__label">ZIP Size</span>
      <span class="stat__value">${formatBytes(zipSize)}</span>
    </div>
    <div class="stat">
      <span class="stat__label">Saved</span>
      <span class="stat__value stat__value--success">${pct}%</span>
    </div>
  `;

  bulkDownloadBtn.href = `/bulk-download/${taskId}`;
  bulkDownloadBtn.download = `bulk-${taskId}.zip`;
  bulkResultSection.hidden = false;
  bulkOptimiseBtn.disabled = false;

  // Reset files
  bulkFiles = [];
  renderBulkFileList();
  updateBulkSummary();
  loadBulkHistory();
}

// ── Bulk History ─────────────────────────────────────────────────────────────

async function loadBulkHistory() {
  try {
    const res = await fetch("/bulk-history");
    const data = await res.json();

    if (!data.length) {
      bulkHistoryList.innerHTML = '<p class="history-empty">No bulk optimisations yet.</p>';
      return;
    }

    bulkHistoryList.innerHTML = data
      .map((entry) => {
        const filesCount = entry.files ? entry.files.length : entry.totalCount;
        const statusBadge =
          entry.status === "completed"
            ? `<span class="history-item__badge history-item__badge--success">Completed</span>`
            : entry.status === "failed"
              ? `<span class="history-item__badge history-item__badge--error">Failed</span>`
              : `<span class="history-item__badge history-item__badge--processing">Processing ${entry.progress}%</span>`;
        const savings =
          entry.status === "completed" && entry.totalInputSize && entry.zipSize
            ? ` · Saved ${Math.round(((entry.totalInputSize - entry.zipSize) / entry.totalInputSize) * 100)}%`
            : "";
        const downloadLink =
          entry.status === "completed"
            ? `<a class="history-item__download" href="/bulk-download/${entry.id}" download>Download ZIP</a>`
            : "";

        return `
          <div class="history-item">
            <div>
              <div class="history-item__name">${filesCount} files · ${formatBytes(entry.totalInputSize)}</div>
              <div class="history-item__meta">
                Scale ${entry.scale}% · Quality ${entry.quality}%
                &nbsp;${statusBadge}${savings}
                &nbsp;·&nbsp;${timeAgo(entry.createdAt)}
              </div>
            </div>
            ${downloadLink}
          </div>`;
      })
      .join("");
  } catch {
    // silent fail
  }
}

// ── Utils ────────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

// ── Init ─────────────────────────────────────────────────────────────────────

loadHistory();
