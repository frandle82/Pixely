(function () {
  const canvas = document.getElementById("pixelCanvas");
  const ctx = canvas.getContext("2d");

  const presetSize = document.getElementById("presetSize");
  const customWidthInput = document.getElementById("customWidth");
  const customHeightInput = document.getElementById("customHeight");
  const applySizeBtn = document.getElementById("applySizeBtn");

  const framesList = document.getElementById("framesList");
  const newFrameBtn = document.getElementById("newFrameBtn");
  const gridInfo = document.getElementById("gridInfo");
  const statusText = document.getElementById("statusText");

  const colorPicker = document.getElementById("colorPicker");
  const brushBtn = document.getElementById("brushBtn");
  const eraserBtn = document.getElementById("eraserBtn");
  const rectBtn = document.getElementById("rectBtn");
  const circleBtn = document.getElementById("circleBtn");
  const fillBtn = document.getElementById("fillBtn");
  const mirrorToggleBtn = document.getElementById("mirrorToggleBtn");

  const saveBtn = document.getElementById("saveBtn");
  const loadBtn = document.getElementById("loadBtn");
  const loadInput = document.getElementById("loadInput");
  const clearBtn = document.getElementById("clearBtn");
  const exportPngBtn = document.getElementById("exportPngBtn");
  const exportGifBtn = document.getElementById("exportGifBtn");
  const gifPreviewCanvas = document.getElementById("gifPreviewCanvas");
  const gifPreviewCtx = gifPreviewCanvas.getContext("2d");
  const gifFpsInput = document.getElementById("gifFpsInput");
  const gifFpsValue = document.getElementById("gifFpsValue");
  const togglePreviewBtn = document.getElementById("togglePreviewBtn");
  const restartPreviewBtn = document.getElementById("restartPreviewBtn");

  const brushSizeButtons = Array.from(document.querySelectorAll(".brush-size-btn"));

  const frameThumbSize =
    parseInt(getComputedStyle(document.documentElement).getPropertyValue("--frame-thumb"), 10) || 86;

  const CANVAS_SIZE = 1024;
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;

  const MIN_SIZE = 5;
  const MAX_SIZE = 64;

  let gridWidth = 8;
  let gridHeight = 8;
  let cellWidth = CANVAS_SIZE / gridWidth;
  let cellHeight = CANVAS_SIZE / gridHeight;

  let frames = [];
  let currentFrameIndex = 0;

  // Werkzeuge: "pinsel", "radierer", "rechteck", "kreis", "fuellen"
  let currentTool = "pinsel";
  let currentColor = colorPicker.value;
  let brushSize = 1; // 1..4 -> 1x1..4x4
  let mirrorMode = false;

  let isDrawing = false;
  let isShapeDrawing = false;
  let shapeStart = null;
  let shapeCurrent = null;

  let previewTimer = null;
  let previewIndex = 0;
  let previewPlaying = false;
  let dragIndex = null;
  let flashActionsIndex = null;
  let flashActionsTimeout = null;
  let gifExporting = false;

  const toolButtons = {
    pinsel: brushBtn,
    radierer: eraserBtn,
    rechteck: rectBtn,
    kreis: circleBtn,
    fuellen: fillBtn,
  };

  function setStatus(msg) {
    statusText.textContent = msg;
  }

  function flashFrameActions(index) {
    flashActionsIndex = index;
    if (flashActionsTimeout) {
      clearTimeout(flashActionsTimeout);
      flashActionsTimeout = null;
    }
  }

  const DEFAULT_GIF_FPS = 5;

  function getGifTiming() {
    const parsed = parseInt(gifFpsInput.value, 10);
    const fps = Math.max(1, Math.min(24, Number.isFinite(parsed) ? parsed : DEFAULT_GIF_FPS));
    gifFpsInput.value = fps;
    gifFpsValue.textContent = `${fps} FPS`;
    return { fps, delayMs: Math.round(1000 / fps) };
  }

  function buildPaletteAndFramesFromRgba(rgbaFrames, exportSize) {
    const colors = [];
    const colorToIndex = new Map();
    let needsTransparency = false;

    function ensureColorIndex(rgb) {
      const key = rgb.join(",");
      let idx = colorToIndex.get(key);
      if (idx === undefined) {
        colors.push(rgb);
        idx = colors.length - 1;
        colorToIndex.set(key, idx);
      }
      return idx;
    }

    const indexedFrames = rgbaFrames.map(buffer => {
      const frame = new Uint8Array(exportSize * exportSize);
      for (let i = 0, p = 0; i < buffer.length; i += 4, p++) {
        const r = buffer[i];
        const g = buffer[i + 1];
        const b = buffer[i + 2];
        const a = buffer[i + 3];
        if (a < 16) {
          frame[p] = 0xff;
          needsTransparency = true;
        } else {
          const idx = ensureColorIndex([r, g, b]);
          frame[p] = idx;
        }
      }
      return frame;
    });

    const maxColors = needsTransparency ? 255 : 256;
    if (colors.length > maxColors) {
      throw new Error(`Zu viele Farben für GIF-Palette (max. ${maxColors}${needsTransparency ? " mit Transparenz" : ""}).`);
    }

    let palette = colors.slice();
    let transparentIndex = null;

    if (needsTransparency) {
      transparentIndex = 0;
      palette = [[0, 0, 0], ...colors];
      indexedFrames.forEach(frame => {
        for (let i = 0; i < frame.length; i++) {
          if (frame[i] === 0xff) {
            frame[i] = 0;
          } else {
            frame[i] = frame[i] + 1;
          }
        }
      });
    }

    let paletteSize = 1;
    while (paletteSize < palette.length) paletteSize <<= 1;
    paletteSize = Math.max(2, paletteSize);
    while (palette.length < paletteSize) palette.push([0, 0, 0]);

    return { palette, indexedFrames, transparentIndex };
  }

  function lzwEncode(minCodeSize, indexStream) {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    let nextCode = endCode + 1;
    let codeSize = minCodeSize + 1;
    const dict = new Map();
    for (let i = 0; i < clearCode; i++) {
      dict.set(String.fromCharCode(i), i);
    }

    const output = [];
    let bitBuffer = 0;
    let bitLength = 0;

    function writeCode(code) {
      bitBuffer |= code << bitLength;
      bitLength += codeSize;
      while (bitLength >= 8) {
        output.push(bitBuffer & 0xff);
        bitBuffer >>= 8;
        bitLength -= 8;
      }
    }

    writeCode(clearCode);
    let prefix = String.fromCharCode(indexStream[0]);

    for (let i = 1; i < indexStream.length; i++) {
      const char = String.fromCharCode(indexStream[i]);
      const combined = prefix + char;
      if (dict.has(combined)) {
        prefix = combined;
      } else {
        writeCode(dict.get(prefix));
        dict.set(combined, nextCode++);
        prefix = char;
        if (nextCode === 1 << codeSize && codeSize < 12) {
          codeSize++;
        }
      }
      if (nextCode >= 4095) {
        writeCode(clearCode);
        dict.clear();
        for (let k = 0; k < clearCode; k++) {
          dict.set(String.fromCharCode(k), k);
        }
        nextCode = endCode + 1;
        codeSize = minCodeSize + 1;
        prefix = char;
        continue;
      }
    }

    if (!dict.has(prefix)) {
      prefix = prefix.slice(-1);
    }
    writeCode(dict.get(prefix));
    writeCode(endCode);

    if (bitLength > 0) {
      output.push(bitBuffer & 0xff);
    }

    return output;
  }

  function encodeGif(frames, palette, width, height, delayCs, transparentIndex) {
    if (typeof GifWriter !== "function") {
      throw new Error("GifWriter nicht geladen.");
    }

    const paletteInts = palette.map(([r, g, b]) => (r << 16) | (g << 8) | b);
    const bufferSize = width * height * frames.length * 2 + paletteInts.length * 4 + 2048;
    const buffer = new Uint8Array(bufferSize);
    const writer = new GifWriter(buffer, width, height, { loop: 0 });

    frames.forEach(frame => {
      writer.addFrame(0, 0, width, height, frame, {
        palette: paletteInts,
        delay: delayCs,
        disposal: transparentIndex !== null ? 2 : 0,
        transparent: transparentIndex ?? undefined,
      });
    });

    const end = writer.end();
    return new Blob([buffer.subarray(0, end)], { type: "image/gif" });
  }

  function renderPreviewFrame(idx) {
    if (!frames.length) return;
    previewIndex = Math.max(0, Math.min(idx, frames.length - 1));
    gifPreviewCtx.clearRect(0, 0, gifPreviewCanvas.width, gifPreviewCanvas.height);
    drawGridToContext(
      gifPreviewCtx,
      frames[previewIndex],
      gridWidth,
      gridHeight,
      false,
      gifPreviewCanvas.width
    );
  }

  function stopPreview() {
    if (previewTimer) {
      clearInterval(previewTimer);
      previewTimer = null;
    }
    previewPlaying = false;
    togglePreviewBtn.textContent = "Vorschau abspielen";
  }

  function startPreview() {
    if (!frames.length) return;
    stopPreview();
    previewPlaying = true;
    togglePreviewBtn.textContent = "Vorschau stoppen";
    const { delayMs } = getGifTiming();
    previewIndex = 0;
    renderPreviewFrame(previewIndex);
    previewTimer = setInterval(() => {
      previewIndex = (previewIndex + 1) % frames.length;
      renderPreviewFrame(previewIndex);
    }, delayMs);
  }

  function refreshPreview() {
    if (!previewPlaying) {
      renderPreviewFrame(currentFrameIndex);
    }
  }

  function createEmptyGrid(width, height) {
    return Array.from({ length: height }, () => Array(width).fill(null));
  }

  function initFrames() {
    frames = [createEmptyGrid(gridWidth, gridHeight)];
    currentFrameIndex = 0;
    renderFramesList();
    redrawCanvas();
    updateInfo();
  }

  function getCurrentGrid() {
    return frames[currentFrameIndex];
  }

  function updateInfo() {
    gridInfo.textContent = `${gridWidth}×${gridHeight} | Frame ${currentFrameIndex + 1}/${frames.length}`;
  }

  function createCheckerPattern(ctx, cell = 12) {
    const size = Math.max(6, Math.floor(cell));
    const patternCanvas = document.createElement("canvas");
    patternCanvas.width = size * 2;
    patternCanvas.height = size * 2;
    const pctx = patternCanvas.getContext("2d");
    pctx.fillStyle = "#0b0f19";
    pctx.fillRect(0, 0, patternCanvas.width, patternCanvas.height);
    pctx.fillStyle = "#111827";
    pctx.fillRect(0, 0, size, size);
    pctx.fillRect(size, size, size, size);
    return ctx.createPattern(patternCanvas, "repeat");
  }

  function paintCheckerboard(ctxTarget, width, height, cell = 12) {
    const pattern = createCheckerPattern(ctxTarget, cell);
    ctxTarget.save();
    ctxTarget.fillStyle = pattern;
    ctxTarget.fillRect(0, 0, width, height);
    ctxTarget.restore();
  }

  function drawGridToContext(
    ctxTarget,
    dataGrid,
    width,
    height,
    withLines,
    canvasSize = CANVAS_SIZE,
    withBackground = true
  ) {
    const cw = canvasSize / width;
    const ch = canvasSize / height;
    if (withBackground) {
      paintCheckerboard(ctxTarget, canvasSize, canvasSize, Math.max(8, Math.floor(canvasSize / 16)));
    } else {
      ctxTarget.clearRect(0, 0, canvasSize, canvasSize);
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const color = dataGrid[y][x];
        if (color) {
          ctxTarget.fillStyle = color;
          ctxTarget.fillRect(
            x * cw,
            y * ch,
            Math.ceil(cw),
            Math.ceil(ch)
          );
        }
      }
    }

    if (withLines) {
      ctxTarget.save();
      ctxTarget.strokeStyle = "#d1d5db";
      ctxTarget.lineWidth = 2;
      ctxTarget.setLineDash([]);
      ctxTarget.globalAlpha = 0.7;

      for (let x = 0; x <= width; x++) {
        const px = x * cw + 0.5;
        ctxTarget.beginPath();
        ctxTarget.moveTo(px, 0);
        ctxTarget.lineTo(px, canvasSize);
        ctxTarget.stroke();
      }
      for (let y = 0; y <= height; y++) {
        const py = y * ch + 0.5;
        ctxTarget.beginPath();
        ctxTarget.moveTo(0, py);
        ctxTarget.lineTo(canvasSize, py);
        ctxTarget.stroke();
      }
      ctxTarget.restore();
    }
  }

  function drawThumbnail(canvas, dataGrid) {
    const tctx = canvas.getContext("2d");
    const tw = canvas.width;
    const th = canvas.height;
    const cw = tw / gridWidth;
    const ch = th / gridHeight;

    tctx.clearRect(0, 0, tw, th);
    paintCheckerboard(tctx, tw, th, Math.max(4, Math.floor(tw / 8)));

    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        const color = dataGrid[y][x];
        if (color) {
          tctx.fillStyle = color;
          tctx.fillRect(
            x * cw,
            y * ch,
            Math.ceil(cw),
            Math.ceil(ch)
          );
        }
      }
    }
  }

  function moveFrame(oldIndex, newIndex) {
    if (newIndex < 0 || newIndex >= frames.length) return;
    const [frame] = frames.splice(oldIndex, 1);
    frames.splice(newIndex, 0, frame);
    currentFrameIndex = newIndex;
    flashFrameActions(newIndex);
    renderFramesList();
    redrawCanvas();
    updateInfo();
  }

  function duplicateFrame(index) {
    const base = frames[index];
    const clone = base.map(row => row.slice());
    frames.splice(index + 1, 0, clone);
    currentFrameIndex = index + 1;
    flashFrameActions(currentFrameIndex);
    renderFramesList();
    redrawCanvas();
    updateInfo();
    setStatus("Frame dupliziert.");
  }

  function deleteFrame(index) {
    if (frames.length <= 1) {
      clearCurrentFrame();
      return;
    }
    frames.splice(index, 1);
    if (currentFrameIndex >= frames.length) {
      currentFrameIndex = frames.length - 1;
    }
    renderFramesList();
    redrawCanvas();
    updateInfo();
    setStatus("Frame gelöscht.");
  }

  function renderFramesList() {
    framesList.innerHTML = "";
    const total = frames.length;
    const flashIndex = flashActionsIndex;
    flashActionsIndex = null;
    frames.forEach((grid, idx) => {
      const item = document.createElement("div");
      item.className = "frame-item" + (idx === currentFrameIndex ? " active" : "");
      if (total > 1) {
        item.draggable = true;
      }
      const thumbWrap = document.createElement("div");
      thumbWrap.className = "frame-thumb-wrap";
      const thumb = document.createElement("canvas");
      thumb.className = "frame-thumb";
      thumb.width = frameThumbSize;
      thumb.height = frameThumbSize;
      drawThumbnail(thumb, grid);
      thumbWrap.appendChild(thumb);

      const badge = document.createElement("div");
      badge.className = "frame-index-badge";
      badge.textContent = idx + 1;
      thumbWrap.appendChild(badge);

      item.appendChild(thumbWrap);

      if (idx === currentFrameIndex) {
        const actions = document.createElement("div");
        actions.className = "frame-actions";

        if (total === 1) {
          const dupBtn = document.createElement("button");
          dupBtn.title = "Frame duplizieren";
          dupBtn.innerHTML = `
            <svg viewBox="0 0 24 24" class="icon">
              <rect x="6" y="6" width="11" height="11" rx="1.5"></rect>
              <rect x="9" y="9" width="11" height="11" rx="1.5"></rect>
            </svg>`;
          dupBtn.classList.add("bottom-right");
          dupBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            duplicateFrame(idx);
          });
          actions.style.justifyContent = "flex-end";
          actions.appendChild(dupBtn);
        } else {
          const copyBtn = document.createElement("button");
          copyBtn.title = "Frame kopieren";
          copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" class="icon">
              <rect x="6" y="6" width="10" height="10" rx="1.5"></rect>
              <rect x="10" y="10" width="8" height="8" rx="1.5"></rect>
            </svg>`;
          copyBtn.classList.add("bottom-right");
          copyBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            duplicateFrame(idx);
          });

          const delBtn = document.createElement("button");
          delBtn.title = "Frame löschen";
          delBtn.innerHTML = `
            <svg viewBox="0 0 24 24" class="icon">
              <polyline points="9 4 10 3 14 3 15 4"></polyline>
              <rect x="6" y="5" width="12" height="15" rx="1.5"></rect>
              <line x1="10" y1="9" x2="10" y2="17"></line>
              <line x1="14" y1="9" x2="14" y2="17"></line>
            </svg>`;
          delBtn.classList.add("top-left");
          delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteFrame(idx);
          });

          const moveBtn = document.createElement("button");
          moveBtn.title = "Frame verschieben";
          moveBtn.innerHTML = `
            <svg viewBox="0 0 24 24" class="icon">
              <line x1="12" y1="4" x2="12" y2="20"></line>
              <line x1="4" y1="12" x2="20" y2="12"></line>
              <polyline points="9 7 12 4 15 7"></polyline>
              <polyline points="9 17 12 20 15 17"></polyline>
              <polyline points="7 9 4 12 7 15"></polyline>
              <polyline points="17 9 20 12 17 15"></polyline>
            </svg>`;
          const canMoveLeft = idx > 0;
          const canMoveRight = idx < total - 1;
          moveBtn.disabled = !(canMoveLeft || canMoveRight);
          moveBtn.style.opacity = moveBtn.disabled ? "0.4" : "1";
          moveBtn.classList.add("bottom-left");
          moveBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (moveBtn.disabled) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const preferRight = clickX >= rect.width / 2;
            if (preferRight && canMoveRight) {
              moveFrame(idx, idx + 1);
            } else if (!preferRight && canMoveLeft) {
              moveFrame(idx, idx - 1);
            } else if (canMoveLeft) {
              moveFrame(idx, idx - 1);
            } else if (canMoveRight) {
              moveFrame(idx, idx + 1);
            }
          });

          actions.appendChild(moveBtn);
          actions.appendChild(copyBtn);
          actions.appendChild(delBtn);
        }

        thumbWrap.appendChild(actions);

        if (flashIndex === idx) {
          requestAnimationFrame(() => {
            item.classList.add("show-actions");
            flashActionsTimeout = setTimeout(() => {
              item.classList.remove("show-actions");
              flashActionsTimeout = null;
            }, 900);
          });
        }
      }

      item.addEventListener("click", () => {
        const changed = currentFrameIndex !== idx;
        currentFrameIndex = idx;
        if (changed) {
          flashFrameActions(idx);
        }
        renderFramesList();
        redrawCanvas();
        updateInfo();
      });

      item.addEventListener("dragstart", (e) => {
        if (total <= 1) return;
        dragIndex = idx;
        item.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });

      item.addEventListener("dragover", (e) => {
        if (dragIndex === null || dragIndex === idx || total <= 1) return;
        e.preventDefault();
        item.classList.add("drag-over");
        e.dataTransfer.dropEffect = "move";
      });

      item.addEventListener("dragleave", () => {
        item.classList.remove("drag-over");
      });

      item.addEventListener("drop", (e) => {
        if (dragIndex === null || dragIndex === idx || total <= 1) return;
        e.preventDefault();
        item.classList.remove("drag-over");
        const targetIndex = idx > dragIndex ? idx - 1 : idx;
        moveFrame(dragIndex, targetIndex);
        dragIndex = null;
      });

      item.addEventListener("dragend", () => {
        dragIndex = null;
        item.classList.remove("dragging");
        item.classList.remove("drag-over");
      });

      framesList.appendChild(item);
    });

    framesList.appendChild(newFrameBtn);
  }

  function redrawCanvas() {
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    const grid = getCurrentGrid();
    drawGridToContext(ctx, grid, gridWidth, gridHeight, true);
    refreshPreview();
  }

  function resizeAllFrames(newWidth, newHeight) {
    newWidth = Math.max(MIN_SIZE, Math.min(MAX_SIZE, newWidth));
    newHeight = Math.max(MIN_SIZE, Math.min(MAX_SIZE, newHeight));
    gridWidth = newWidth;
    gridHeight = newHeight;
    cellWidth = CANVAS_SIZE / gridWidth;
    cellHeight = CANVAS_SIZE / gridHeight;
    frames = frames.map(() => createEmptyGrid(gridWidth, gridHeight));
    currentFrameIndex = 0;
    renderFramesList();
    redrawCanvas();
    updateInfo();
    setStatus("Raster geändert.");
  }

  function presetChanged() {
    const [w, h] = presetSize.value.split("x").map(Number);
    customWidthInput.value = w;
    customHeightInput.value = h;
    resizeAllFrames(w, h);
  }

  function applyCustomSize() {
    const w = parseInt(customWidthInput.value, 10);
    const h = parseInt(customHeightInput.value, 10);
    if (Number.isNaN(w) || Number.isNaN(h)) {
      setStatus("Ungültiges Raster.");
      return;
    }
    if (w < MIN_SIZE || w > MAX_SIZE || h < MIN_SIZE || h > MAX_SIZE) {
      setStatus("Rastergröße nur von 5 bis 64 möglich.");
      return;
    }
    resizeAllFrames(w, h);
  }

  function setTool(tool) {
    currentTool = tool;
    isShapeDrawing = false;
    shapeStart = null;
    shapeCurrent = null;
    Object.values(toolButtons).forEach(btn => btn.classList.remove("active"));
    if (toolButtons[tool]) toolButtons[tool].classList.add("active");
    setStatus("Werkzeug: " + tool);
  }

  function toggleMirror() {
    mirrorMode = !mirrorMode;
    mirrorToggleBtn.classList.toggle("active", mirrorMode);
    setStatus(mirrorMode ? "Vertikale Spiegelung: an." : "Vertikale Spiegelung: aus.");
  }

  function clearCurrentFrame() {
    frames[currentFrameIndex] = createEmptyGrid(gridWidth, gridHeight);
    redrawCanvas();
    renderFramesList();
    setStatus("Aktueller Frame geleert.");
  }

  function saveImage() {
    const data = {
      width: gridWidth,
      height: gridHeight,
      frames,
    };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pixely-${gridWidth}x${gridHeight}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus("Projekt gespeichert (JSON).");
  }

  function loadImageFromFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data || typeof data.width !== "number" || typeof data.height !== "number" || !Array.isArray(data.frames)) {
          throw new Error("Formatfehler.");
        }
        if (data.width < MIN_SIZE || data.width > MAX_SIZE || data.height < MIN_SIZE || data.height > MAX_SIZE) {
          throw new Error("Unzulässige Rastergröße.");
        }
        gridWidth = data.width;
        gridHeight = data.height;
        cellWidth = CANVAS_SIZE / gridWidth;
        cellHeight = CANVAS_SIZE / gridHeight;
        frames = data.frames;
        currentFrameIndex = 0;

        customWidthInput.value = gridWidth;
        customHeightInput.value = gridHeight;
        const presetVal = `${gridWidth}x${gridHeight}`;
        if ([...presetSize.options].some(o => o.value === presetVal)) {
          presetSize.value = presetVal;
        }

        renderFramesList();
        redrawCanvas();
        updateInfo();
        setStatus("Projekt geladen.");
      } catch (err) {
        console.error(err);
        setStatus("Fehler beim Laden der Datei.");
      }
    };
    reader.readAsText(file);
  }

  function getCellFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const point =
      (ev.touches && ev.touches[0]) ||
      (ev.changedTouches && ev.changedTouches[0]) ||
      ev;
    const clientX = point.clientX;
    const clientY = point.clientY;
    const x = Math.floor(((clientX - rect.left) / rect.width) * gridWidth);
    const y = Math.floor(((clientY - rect.top) / rect.height) * gridHeight);
    if (x < 0 || x >= gridWidth || y < 0 || y >= gridHeight) return null;
    return { x, y };
  }

  function paintCellAt(grid, x, y, color) {
    if (x < 0 || x >= gridWidth || y < 0 || y >= gridHeight) return;
    grid[y][x] = color;
  }

  function paintBrush(cell) {
    const grid = getCurrentGrid();
    const color = currentTool === "radierer" ? null : currentColor;
    const size = brushSize; // 1..4
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const nx = cell.x + dx;
        const ny = cell.y + dy;
        paintCellAt(grid, nx, ny, color);
        if (mirrorMode) {
          const mirrorStartX = gridWidth - size - cell.x + dx;
          const mx = mirrorStartX;
          const my = ny;
          paintCellAt(grid, mx, my, color);
        }
      }
    }
    redrawCanvas();
    renderFramesList();
  }

  // Rechteck: nur Umriss
  function drawRectShape(start, end, color, targetGrid) {
    const x1 = Math.min(start.x, end.x);
    const x2 = Math.max(start.x, end.x);
    const y1 = Math.min(start.y, end.y);
    const y2 = Math.max(start.y, end.y);

    for (let x = x1; x <= x2; x++) {
      paintCellAt(targetGrid, x, y1, color);
      paintCellAt(targetGrid, x, y2, color);
    }
    for (let y = y1; y <= y2; y++) {
      paintCellAt(targetGrid, x1, y, color);
      paintCellAt(targetGrid, x2, y, color);
    }
  }

  // Kreis/Oval: nur Rand
  function drawCircleShape(start, end, color, targetGrid) {
    const x1 = Math.min(start.x, end.x);
    const x2 = Math.max(start.x, end.x);
    const y1 = Math.min(start.y, end.y);
    const y2 = Math.max(start.y, end.y);

    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const rx = (x2 - x1) / 2 || 0.5;
    const ry = (y2 - y1) / 2 || 0.5;

    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const dist = dx * dx + dy * dy;
        if (dist <= 1.05 && dist >= 0.7) {
          paintCellAt(targetGrid, x, y, color);
        }
      }
    }
  }

  function previewShape(start, end) {
    const original = getCurrentGrid();
    const copy = original.map(row => row.slice());
    const color = currentColor;

    if (currentTool === "rechteck") {
      drawRectShape(start, end, color, copy);
      if (mirrorMode) {
        const w = gridWidth;
        const ms = { x: w - 1 - start.x, y: start.y };
        const me = { x: w - 1 - end.x, y: end.y };
        drawRectShape(ms, me, color, copy);
      }
    } else if (currentTool === "kreis") {
      drawCircleShape(start, end, color, copy);
      if (mirrorMode) {
        const w = gridWidth;
        const ms = { x: w - 1 - start.x, y: start.y };
        const me = { x: w - 1 - end.x, y: end.y };
        drawCircleShape(ms, me, color, copy);
      }
    }

    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    drawGridToContext(ctx, copy, gridWidth, gridHeight, true);
  }

  function applyShape(start, end) {
    if (!start || !end) return;
    const grid = getCurrentGrid();
    const color = currentColor;

    if (currentTool === "rechteck") {
      drawRectShape(start, end, color, grid);
      if (mirrorMode) {
        const w = gridWidth;
        const ms = { x: w - 1 - start.x, y: start.y };
        const me = { x: w - 1 - end.x, y: end.y };
        drawRectShape(ms, me, color, grid);
      }
    } else if (currentTool === "kreis") {
      drawCircleShape(start, end, color, grid);
      if (mirrorMode) {
        const w = gridWidth;
        const ms = { x: w - 1 - start.x, y: start.y };
        const me = { x: w - 1 - end.x, y: end.y };
        drawCircleShape(ms, me, color, grid);
      }
    }

    redrawCanvas();
    renderFramesList();
  }

  function floodFill(startCell) {
    const grid = getCurrentGrid();
    const targetColor = grid[startCell.y][startCell.x] || null;
    const newColor = currentColor;
    if (targetColor === newColor) return;

    const stack = [startCell];
    const visited = new Set();
    function key(x, y) { return x + "," + y; }

    while (stack.length > 0) {
      const { x, y } = stack.pop();
      if (x < 0 || x >= gridWidth || y < 0 || y >= gridHeight) continue;
      const k = key(x, y);
      if (visited.has(k)) continue;
      visited.add(k);

      const current = grid[y][x] || null;
      if (current !== targetColor) continue;

      grid[y][x] = newColor;

      stack.push({ x: x + 1, y });
      stack.push({ x: x - 1, y });
      stack.push({ x, y: y + 1 });
      stack.push({ x, y: y - 1 });
    }

    if (mirrorMode) {
      const mirrorStart = { x: gridWidth - 1 - startCell.x, y: startCell.y };
      const stack2 = [mirrorStart];
      const visited2 = new Set();
      const targetMirror = grid[mirrorStart.y][mirrorStart.x] || null;
      if (targetMirror !== newColor) {
        while (stack2.length > 0) {
          const { x, y } = stack2.pop();
          if (x < 0 || x >= gridWidth || y < 0 || y >= gridHeight) continue;
          const k2 = key(x, y);
          if (visited2.has(k2)) continue;
          visited2.add(k2);

          const current2 = grid[y][x] || null;
          if (current2 !== targetMirror) continue;

          grid[y][x] = newColor;

          stack2.push({ x: x + 1, y });
          stack2.push({ x: x - 1, y });
          stack2.push({ x, y: y + 1 });
          stack2.push({ x, y: y - 1 });
        }
      }
    }

    redrawCanvas();
    renderFramesList();
  }

  // Pointer
  function handlePointerDown(ev) {
    const cell = getCellFromEvent(ev);
    if (!cell) return;

    if (currentTool === "pinsel" || currentTool === "radierer") {
      isDrawing = true;
      paintBrush(cell);
    } else if (currentTool === "rechteck" || currentTool === "kreis") {
      isShapeDrawing = true;
      shapeStart = cell;
      shapeCurrent = cell;
      previewShape(shapeStart, shapeCurrent);
    } else if (currentTool === "fuellen") {
      floodFill(cell);
      setStatus("Fläche gefüllt.");
    }
  }

  function handlePointerMove(ev) {
    const cell = getCellFromEvent(ev);
    if (!cell) return;
    if (isDrawing && (currentTool === "pinsel" || currentTool === "radierer")) {
      paintBrush(cell);
    } else if (isShapeDrawing && shapeStart && (currentTool === "rechteck" || currentTool === "kreis")) {
      shapeCurrent = cell;
      previewShape(shapeStart, shapeCurrent);
    }
  }

  function handlePointerUp() {
    if (isDrawing) {
      isDrawing = false;
      return;
    }
    if (isShapeDrawing) {
      isShapeDrawing = false;
      if (shapeStart && shapeCurrent) {
        applyShape(shapeStart, shapeCurrent);
      } else {
        redrawCanvas();
      }
      shapeStart = null;
      shapeCurrent = null;
    }
  }

  function addEmptyFrameAfterCurrent() {
    const empty = createEmptyGrid(gridWidth, gridHeight);
    frames.splice(currentFrameIndex + 1, 0, empty);
    currentFrameIndex++;
    flashFrameActions(currentFrameIndex);
    renderFramesList();
    redrawCanvas();
    updateInfo();
    setStatus("Neues leeres Bild erstellt.");
  }

  function exportPNG() {
    const exportSize = Math.min(1024, Math.max(gridWidth, gridHeight) * 32);
    const offscreen = document.createElement("canvas");
    offscreen.width = exportSize;
    offscreen.height = exportSize;
    const offCtx = offscreen.getContext("2d");

    drawGridToContext(offCtx, getCurrentGrid(), gridWidth, gridHeight, false, exportSize, false);

    const a = document.createElement("a");
    a.download = `pixely-${gridWidth}x${gridHeight}-frame${currentFrameIndex + 1}.png`;
    a.href = offscreen.toDataURL("image/png");
    a.click();
    setStatus("PNG exportiert.");
  }

  function colorToRgbArray(hex) {
    if (!hex || typeof hex !== "string" || hex[0] !== "#" || hex.length !== 7) return null;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
  }

  function gridToPixelData(grid, width, height, exportSize) {
    const offscreen = document.createElement("canvas");
    offscreen.width = exportSize;
    offscreen.height = exportSize;
    const offCtx = offscreen.getContext("2d");
    offCtx.clearRect(0, 0, exportSize, exportSize);

    drawGridToContext(offCtx, grid, width, height, false, exportSize, false);

    return offCtx.getImageData(0, 0, exportSize, exportSize).data;
  }

  function getFramePixelBuffers(exportSize = Math.min(512, Math.max(gridWidth, gridHeight) * 32)) {
    return frames.map(grid => gridToPixelData(grid, gridWidth, gridHeight, exportSize));
  }

  function exportGIF() {
    if (gifExporting) return;
    if (!frames.length) {
      setStatus("Keine Frames vorhanden.");
      return;
    }

    const { fps, delayMs } = getGifTiming();
    const exportSize = Math.min(512, Math.max(gridWidth, gridHeight) * 32);
    gifExporting = true;
    exportGifBtn.disabled = true;
    exportGifBtn.textContent = "GIF wird erstellt …";

    const restoreButton = message => {
      gifExporting = false;
      exportGifBtn.disabled = false;
      exportGifBtn.textContent = "GIF";
      if (message) {
        setStatus(message);
      }
    };

    setTimeout(() => {
      try {
        const rgbaFrames = frames.map(grid => gridToPixelData(grid, gridWidth, gridHeight, exportSize));
        const { palette, indexedFrames, transparentIndex } = buildPaletteAndFramesFromRgba(
          rgbaFrames,
          exportSize
        );
        const delayCs = Math.max(1, Math.round(delayMs / 10));
        const blob = encodeGif(indexedFrames, palette, exportSize, exportSize, delayCs, transparentIndex);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `pixely-${gridWidth}x${gridHeight}.gif`;
        a.click();
        URL.revokeObjectURL(url);
        restoreButton(`GIF exportiert (${fps} FPS).`);
      } catch (err) {
        console.error(err);
        restoreButton("GIF-Export fehlgeschlagen.");
      }
    }, 20);
  }

  window.pixelyApp = {
    exportGif: exportGIF,
    exportPng: exportPNG,
    getFrames: () => frames.map(frame => frame.map(cell => cell)),
    getGridSize: () => ({ width: gridWidth, height: gridHeight }),
    getFramePixelBuffers,
  };

  // Events
  presetSize.addEventListener("change", presetChanged);
  applySizeBtn.addEventListener("click", applyCustomSize);

  newFrameBtn.addEventListener("click", addEmptyFrameAfterCurrent);

  brushBtn.addEventListener("click", () => setTool("pinsel"));
  eraserBtn.addEventListener("click", () => setTool("radierer"));
  rectBtn.addEventListener("click", () => setTool("rechteck"));
  circleBtn.addEventListener("click", () => setTool("kreis"));
  fillBtn.addEventListener("click", () => setTool("fuellen"));

  mirrorToggleBtn.addEventListener("click", toggleMirror);

  colorPicker.addEventListener("input", e => {
    currentColor = e.target.value;
  });

  brushSizeButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      brushSizeButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      brushSize = parseInt(btn.dataset.size, 10) || 1;
    });
  });

  saveBtn.addEventListener("click", saveImage);
  loadBtn.addEventListener("click", () => loadInput.click());
  loadInput.addEventListener("change", e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    loadImageFromFile(file);
    loadInput.value = "";
  });

  clearBtn.addEventListener("click", clearCurrentFrame);

  exportPngBtn.addEventListener("click", exportPNG);
  exportGifBtn.addEventListener("click", exportGIF);
  gifFpsInput.addEventListener("input", () => {
    getGifTiming();
    if (previewPlaying) {
      startPreview();
    } else {
      refreshPreview();
    }
  });
  togglePreviewBtn.addEventListener("click", () => {
    if (previewPlaying) {
      stopPreview();
    } else {
      startPreview();
    }
  });
  restartPreviewBtn.addEventListener("click", () => {
    stopPreview();
    renderPreviewFrame(currentFrameIndex);
  });

  canvas.addEventListener("mousedown", handlePointerDown);
  canvas.addEventListener("mousemove", handlePointerMove);
  window.addEventListener("mouseup", handlePointerUp);

  canvas.addEventListener("touchstart", e => {
    e.preventDefault();
    handlePointerDown(e);
  }, { passive: false });
  canvas.addEventListener("touchmove", e => {
    e.preventDefault();
    handlePointerMove(e);
  }, { passive: false });
  canvas.addEventListener("touchend", e => {
    e.preventDefault();
    handlePointerUp();
  }, { passive: false });

  // Start
  initFrames();
  getGifTiming();
  setTool("pinsel");
  setStatus("Bereit zum Zeichnen.");
})();
