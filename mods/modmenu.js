(() => {
  "use strict";

  const STORAGE_KEY = "sr_modmenu_v1";

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const fmt = (n, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : String(n));

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }

  const state =
    loadState() || {
      open: false,
      mods: {
        gravity: 1,
        speed: 1,
        jump: 1,
        rotation: 1,
        accel: 1,
      },
      gravity: {
        detected: false,
        heapIndex: null, // index in HEAPF32 (not bytes)
        baseline: null,
      },
      physics: {
        detected: false,
        vSpeedIndex: null,
        baseMoveSpeedIndex: null,
        speedAccelerationIndex: null,
        rotationSpeedIndex: null,
        jumpSpeedIndex: null,
        baseline: {},
      },
    };

  let unityInstance = null;
  let unityModule = null;
  let enforceTimer = null;
  const logBuffer = [];
  const LOG_BUFFER_MAX = 250;
  let logSeq = 0;
  const knownObjects = new Set();

  function getUnity() {
    const gi = unityInstance || window.gameInstance;
    if (!gi || !gi.Module || !gi.Module.HEAPF32) return null;
    return gi;
  }

  function getModule() {
    const gi = getUnity();
    return gi ? gi.Module : null;
  }

  function sendMessage(goName, methodName, param) {
    const gi = getUnity();
    if (!gi || typeof gi.SendMessage !== "function") return false;
    try {
      if (param === undefined) gi.SendMessage(goName, methodName);
      else gi.SendMessage(goName, methodName, param);
      return true;
    } catch {
      return false;
    }
  }

  function pushLogLine(line) {
    logSeq += 1;
    logBuffer.push({ seq: logSeq, line: String(line ?? "") });
    while (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();

    const text = String(line ?? "");
    const extracted = new Set();
    const m1 = text.match(/Game Object '([^']+)'/);
    if (m1 && m1[1]) extracted.add(m1[1]);
    const m2 = text.match(/SendMessage: object ([^!]+) not found!/);
    if (m2 && m2[1]) extracted.add(m2[1].trim());
    const m3 = text.match(/Scene hierarchy path \"([^\"]+)\"/);
    if (m3 && m3[1]) {
      const first = m3[1].split("/")[0];
      if (first) extracted.add(first);
    }
    for (const name of extracted) {
      if (!name || name.length > 64) continue;
      knownObjects.add(name);
    }
    refreshObjectDatalists();
  }

  function hookUnityLogging() {
    const module = getModule();
    if (!module) return;
    if (module.__srModsPrintHooked) return;
    module.__srModsPrintHooked = true;

    const origPrint = module.print;
    const origPrintErr = module.printErr;

    module.print = function (...args) {
      try {
        if (args.length) pushLogLine(args.join(" "));
      } catch {
        // ignore
      }
      if (typeof origPrint === "function") return origPrint.apply(this, args);
      // UnityLoader expects print to exist, but not always.
      try {
        // eslint-disable-next-line no-console
        console.log(...args);
      } catch {
        // ignore
      }
    };

    module.printErr = function (...args) {
      try {
        if (args.length) pushLogLine(args.join(" "));
      } catch {
        // ignore
      }
      if (typeof origPrintErr === "function") return origPrintErr.apply(this, args);
      try {
        // eslint-disable-next-line no-console
        console.error(...args);
      } catch {
        // ignore
      }
    };
  }

  async function sendMessageChecked(goName, methodName, param) {
    const startSeq = logSeq;
    const okCall = sendMessage(goName, methodName, param);
    if (!okCall) return { ok: false, reason: "SendMessage threw (Unity not ready?)" };

    // Give Unity a brief moment to print SendMessage errors (if any).
    await sleep(75);
    const newLines = logBuffer.filter((x) => x.seq > startSeq).map((x) => x.line);
    const sendMsgLine = newLines.find((l) => String(l).startsWith("SendMessage:"));
    if (sendMsgLine) return { ok: false, reason: sendMsgLine };
    return { ok: true, reason: "No SendMessage error observed." };
  }

  function ensureRoot() {
    if (document.getElementById("sr-modmenu-root")) return;

    const root = document.createElement("div");
    root.id = "sr-modmenu-root";

    root.innerHTML = `
      <div id="sr-modmenu-toggle-hint" title="Toggle mod menu">
        <div style="font-weight:700;font-size:12px;">Mods</div>
        <div style="opacity:.9;font-size:12px;">Insert / F2</div>
      </div>
      <div id="sr-modmenu-panel" class="${state.open ? "" : "sr-hidden"}">
        <div class="sr-mm-header">
          <div>
            <div class="sr-mm-title">Snow Rider Mod Menu</div>
            <div class="sr-mm-subtitle">Offline/singleplayer only</div>
          </div>
          <button class="sr-mm-btn" id="sr-mm-close">Close</button>
        </div>
        <div class="sr-mm-body">
          <div class="sr-mm-section">
            <h3>Gravity</h3>
            <div class="sr-mm-row">
              <label for="sr-mm-grav">Gravity multiplier</label>
              <div class="sr-mm-value" id="sr-mm-grav-val">x${fmt(state.mods.gravity, 2)}</div>
            </div>
            <input id="sr-mm-grav" type="range" min="0.2" max="3" step="0.05" value="${state.mods.gravity}">
            <div class="sr-mm-actions" style="margin-top:10px;">
              <button class="sr-mm-btn sr-mm-primary" id="sr-mm-detect-grav">Auto-detect physics</button>
              <button class="sr-mm-btn" id="sr-mm-reset-grav">Reset</button>
            </div>
            <div class="sr-mm-status" id="sr-mm-grav-status" style="margin-top:8px;"></div>
          </div>

          <div class="sr-mm-section">
            <h3>Physics Mods</h3>
            <div class="sr-mm-row">
              <label for="sr-mm-speed">Speed multiplier</label>
              <div class="sr-mm-value" id="sr-mm-speed-val">x${fmt(state.mods.speed, 2)}</div>
            </div>
            <input id="sr-mm-speed" type="range" min="0.25" max="3" step="0.05" value="${state.mods.speed}">

            <div class="sr-mm-row" style="margin-top:10px;">
              <label for="sr-mm-jump">Jump multiplier</label>
              <div class="sr-mm-value" id="sr-mm-jump-val">x${fmt(state.mods.jump, 2)}</div>
            </div>
            <input id="sr-mm-jump" type="range" min="0.25" max="3" step="0.05" value="${state.mods.jump}">

            <div class="sr-mm-row" style="margin-top:10px;">
              <label for="sr-mm-rot">Rotation multiplier</label>
              <div class="sr-mm-value" id="sr-mm-rot-val">x${fmt(state.mods.rotation, 2)}</div>
            </div>
            <input id="sr-mm-rot" type="range" min="0.25" max="3" step="0.05" value="${state.mods.rotation}">

            <div class="sr-mm-row" style="margin-top:10px;">
              <label for="sr-mm-accel">Accel multiplier</label>
              <div class="sr-mm-value" id="sr-mm-accel-val">x${fmt(state.mods.accel, 2)}</div>
            </div>
            <input id="sr-mm-accel" type="range" min="0.25" max="3" step="0.05" value="${state.mods.accel}">

            <div class="sr-mm-actions" style="margin-top:10px;">
              <button class="sr-mm-btn sr-mm-primary" id="sr-mm-apply-physics">Apply now</button>
              <button class="sr-mm-btn" id="sr-mm-reset-physics">Reset physics</button>
            </div>
            <div class="sr-mm-status" id="sr-mm-physics-status" style="margin-top:8px;"></div>
          </div>

          <div class="sr-mm-section">
            <h3>Keys</h3>
            <div class="sr-mm-status">Toggle menu: <code>Insert</code> or <code>F2</code></div>
          </div>

          <div class="sr-mm-section">
            <h3>Debug</h3>
            <div class="sr-mm-status" id="sr-mm-debug-status">Waiting for logs…</div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const toggleHint = document.getElementById("sr-modmenu-toggle-hint");
    toggleHint.addEventListener("click", () => setOpen(!state.open));

    document.getElementById("sr-mm-close").addEventListener("click", () => setOpen(false));

    const gravSlider = document.getElementById("sr-mm-grav");
    gravSlider.addEventListener("input", () => {
      state.mods.gravity = Number(gravSlider.value);
      document.getElementById("sr-mm-grav-val").textContent = `x${fmt(state.mods.gravity, 2)}`;
      saveState(state);
      applyGravityAndPhysics();
    });

    document.getElementById("sr-mm-detect-grav").addEventListener("click", async () => {
      await detectPhysicsInteractive();
    });

    document.getElementById("sr-mm-reset-grav").addEventListener("click", () => {
      state.mods.gravity = 1;
      gravSlider.value = String(state.mods.gravity);
      document.getElementById("sr-mm-grav-val").textContent = `x${fmt(state.mods.gravity, 2)}`;
      saveState(state);
      applyGravityAndPhysics(true);
    });

    const speedSlider = document.getElementById("sr-mm-speed");
    speedSlider.addEventListener("input", () => {
      state.mods.speed = Number(speedSlider.value);
      document.getElementById("sr-mm-speed-val").textContent = `x${fmt(state.mods.speed, 2)}`;
      saveState(state);
    });

    const jumpSlider = document.getElementById("sr-mm-jump");
    jumpSlider.addEventListener("input", () => {
      state.mods.jump = Number(jumpSlider.value);
      document.getElementById("sr-mm-jump-val").textContent = `x${fmt(state.mods.jump, 2)}`;
      saveState(state);
    });

    const rotSlider = document.getElementById("sr-mm-rot");
    rotSlider.addEventListener("input", () => {
      state.mods.rotation = Number(rotSlider.value);
      document.getElementById("sr-mm-rot-val").textContent = `x${fmt(state.mods.rotation, 2)}`;
      saveState(state);
    });

    const accelSlider = document.getElementById("sr-mm-accel");
    accelSlider.addEventListener("input", () => {
      state.mods.accel = Number(accelSlider.value);
      document.getElementById("sr-mm-accel-val").textContent = `x${fmt(state.mods.accel, 2)}`;
      saveState(state);
    });

    document.getElementById("sr-mm-apply-physics").addEventListener("click", () => applyGravityAndPhysics());
    document.getElementById("sr-mm-reset-physics").addEventListener("click", () => {
      state.mods.speed = 1;
      state.mods.jump = 1;
      state.mods.rotation = 1;
      state.mods.accel = 1;
      speedSlider.value = String(state.mods.speed);
      jumpSlider.value = String(state.mods.jump);
      rotSlider.value = String(state.mods.rotation);
      accelSlider.value = String(state.mods.accel);
      document.getElementById("sr-mm-speed-val").textContent = `x${fmt(state.mods.speed, 2)}`;
      document.getElementById("sr-mm-jump-val").textContent = `x${fmt(state.mods.jump, 2)}`;
      document.getElementById("sr-mm-rot-val").textContent = `x${fmt(state.mods.rotation, 2)}`;
      document.getElementById("sr-mm-accel-val").textContent = `x${fmt(state.mods.accel, 2)}`;
      saveState(state);
      applyGravityAndPhysics(true);
    });

    updateStatus();
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setOpen(open) {
    state.open = !!open;
    saveState(state);
    const panel = document.getElementById("sr-modmenu-panel");
    if (panel) panel.classList.toggle("sr-hidden", !state.open);
  }

  function updateStatus(extra = {}) {
    const gravStatus = document.getElementById("sr-mm-grav-status");
    const physicsStatus = document.getElementById("sr-mm-physics-status");
    const debugStatus = document.getElementById("sr-mm-debug-status");
    if (!gravStatus || !physicsStatus) return;

    const gi = getUnity();
    if (!gi) {
      gravStatus.textContent = "Waiting for Unity to finish loading…";
      physicsStatus.textContent = "Waiting for Unity to finish loading…";
      if (debugStatus) debugStatus.textContent = "Unity not ready yet.";
      return;
    }

    const module = getModule();
    const heap = module && module.HEAPF32 ? module.HEAPF32 : null;

    if (!state.gravity.detected) {
      gravStatus.textContent =
        extra.gravityStatus ||
        "Not detected yet. Click “Auto-detect physics” while you’re in a run (when the sled is moving).";
    } else {
      const cur =
        heap && Number.isInteger(state.gravity.heapIndex) ? heap[state.gravity.heapIndex] : NaN;
      gravStatus.textContent =
        extra.gravityStatus ||
        `Detected. gravityAcc @ HEAPF32[${state.gravity.heapIndex}] baseline=${fmt(
          state.gravity.baseline,
          3
        )} current=${fmt(cur, 3)}.`;
    }

    physicsStatus.textContent =
      extra.physicsStatus ||
      (state.physics.detected
        ? `Detected: baseMoveSpeed[${state.physics.baseMoveSpeedIndex}]=${fmt(
            heap && Number.isInteger(state.physics.baseMoveSpeedIndex) ? heap[state.physics.baseMoveSpeedIndex] : NaN,
            2
          )} jump[${state.physics.jumpSpeedIndex}]=${fmt(
            heap && Number.isInteger(state.physics.jumpSpeedIndex) ? heap[state.physics.jumpSpeedIndex] : NaN,
            2
          )} rot[${state.physics.rotationSpeedIndex}]=${fmt(
            heap && Number.isInteger(state.physics.rotationSpeedIndex) ? heap[state.physics.rotationSpeedIndex] : NaN,
            2
          )} accel[${state.physics.speedAccelerationIndex}]=${fmt(
            heap && Number.isInteger(state.physics.speedAccelerationIndex)
              ? heap[state.physics.speedAccelerationIndex]
              : NaN,
            3
          )}`
        : "Not detected yet. Click “Auto-detect physics” during a run.");

    if (debugStatus) {
      const last = logBuffer.length ? logBuffer[logBuffer.length - 1].line : "";
      debugStatus.textContent = extra.debugStatus || (last ? `Last log: ${last}` : "No Unity logs captured yet.");
    }
  }

  function applyGravityAndPhysics(forceReset = false, silent = false) {
    applyGravity(forceReset, silent);
    applyPhysics(forceReset, silent);
  }

  function applyGravity(forceReset = false, silent = false) {
    if (!state.gravity.detected) return;
    const module = getModule();
    if (!module || !module.HEAPF32) return;

    const idx = state.gravity.heapIndex;
    const baseline = state.gravity.baseline;
    if (!Number.isInteger(idx) || !Number.isFinite(baseline)) return;
    if (idx < 0 || idx >= module.HEAPF32.length) return;

    const mult = forceReset ? 1 : clamp(Number(state.mods.gravity), 0.05, 5);
    module.HEAPF32[idx] = baseline * mult;
    if (!silent) {
      updateStatus({
        gravityStatus: `Applied gravity: ${fmt(module.HEAPF32[idx], 3)} (x${fmt(mult, 2)})`,
      });
    }
  }

  function applyPhysics(forceReset = false, silent = false) {
    if (!state.physics.detected) return;
    const module = getModule();
    if (!module || !module.HEAPF32) return;
    const heap = module.HEAPF32;

    const applyIdx = (key, idx, mult) => {
      if (!Number.isInteger(idx) || idx < 0 || idx >= heap.length) return;
      const base = state.physics.baseline[key];
      if (!Number.isFinite(base)) return;
      heap[idx] = base * mult;
    };

    const speedMult = forceReset ? 1 : clamp(Number(state.mods.speed), 0.05, 8);
    const jumpMult = forceReset ? 1 : clamp(Number(state.mods.jump), 0.05, 8);
    const rotMult = forceReset ? 1 : clamp(Number(state.mods.rotation), 0.05, 8);
    const accelMult = forceReset ? 1 : clamp(Number(state.mods.accel), 0.05, 8);

    applyIdx("baseMoveSpeed", state.physics.baseMoveSpeedIndex, speedMult);
    applyIdx("jumpSpeed", state.physics.jumpSpeedIndex, jumpMult);
    applyIdx("rotationSpeed", state.physics.rotationSpeedIndex, rotMult);
    applyIdx("speedAcceleration", state.physics.speedAccelerationIndex, accelMult);

    if (!silent) {
      updateStatus({
        physicsStatus: `Applied: speed x${fmt(speedMult, 2)} jump x${fmt(jumpMult, 2)} rot x${fmt(
          rotMult,
          2
        )} accel x${fmt(accelMult, 2)}`,
      });
    }
  }

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function sampleAt(heap, indexList) {
    const out = new Float32Array(indexList.length);
    for (let i = 0; i < indexList.length; i++) out[i] = heap[indexList[i]];
    return out;
  }

  function scoreGravityCandidate(beforeDeltas, afterDeltas, expectedFactor) {
    const avgAbs = (arr) => {
      let s = 0;
      for (let i = 0; i < arr.length; i++) s += Math.abs(arr[i]);
      return s / Math.max(1, arr.length);
    };
    const b = avgAbs(beforeDeltas);
    const a = avgAbs(afterDeltas);
    if (!Number.isFinite(b) || !Number.isFinite(a) || b < 1e-4) return 0;
    const ratio = a / b;
    const closeness = 1 / (1 + Math.abs(ratio - expectedFactor));
    const signal = Math.min(1, b / 0.01);
    return closeness * signal;
  }

  async function detectPhysicsInteractive() {
    ensureRoot();
    updateStatus({ gravityStatus: "Detecting… keep the sled moving for a few seconds." });

    const gi = getUnity();
    if (!gi) {
      updateStatus({ gravityStatus: "Unity not ready yet." });
      return;
    }
    unityInstance = gi;
    unityModule = gi.Module;
    hookUnityLogging();

    const module = getModule();
    const heap = module && module.HEAPF32;
    if (!heap) {
      updateStatus({ gravityStatus: "No HEAPF32 found." });
      return;
    }

    // Coarse pass: sample floats across the heap and keep ones that change (potential vSpeed-like fields).
    const candidates = [];
    const sampleCount = 90000;
    let seed = (Date.now() ^ (heap.length >>> 1)) >>> 0;
    for (let s = 0; s < sampleCount; s++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const i = seed % (heap.length - 8);
      const v = heap[i];
      if (!Number.isFinite(v)) continue;
      if (Math.abs(v) > 250) continue;
      candidates.push(i);
    }

    const snap1 = sampleAt(heap, candidates);
    await sleep(140);
    const snap2 = sampleAt(heap, candidates);

    const moving = [];
    for (let k = 0; k < candidates.length; k++) {
      const d = snap2[k] - snap1[k];
      if (Math.abs(d) > 0.002) moving.push(candidates[k]);
    }

    if (moving.length === 0) {
      updateStatus({
        gravityStatus:
          "Couldn’t find any changing values (try starting a run first, then click Detect again).",
      });
      return;
    }

    // Fine pass: for each moving index, look around it for a nearby stable positive float (gravityAcc candidate).
    const finePairs = [];
    const radius = 256;
    for (const vIdx of moving.slice(0, 4500)) {
      const start = Math.max(8, vIdx - radius);
      const end = Math.min(heap.length - 8, vIdx + radius);
      for (let gIdx = start; gIdx < end; gIdx++) {
        if (gIdx === vIdx) continue;
        const gVal = heap[gIdx];
        if (!Number.isFinite(gVal) || gVal <= 0 || gVal > 250) continue;
        finePairs.push({ vIdx, gIdx, gVal });
        if (finePairs.length >= 700) break;
      }
      if (finePairs.length >= 700) break;
    }

    if (finePairs.length === 0) {
      updateStatus({
        gravityStatus:
          "No candidates found (try again while moving, or restart the run and retry).",
      });
      return;
    }

    // Validate candidates by temporarily scaling the candidate and observing the vIdx delta magnitude.
    const expectedFactor = 1.75;
    let best = null;
    for (const pair of finePairs) {
      const { vIdx, gIdx } = pair;
      const originalG = heap[gIdx];
      if (!Number.isFinite(originalG) || originalG <= 0) continue;

      const before = [];
      for (let s = 0; s < 8; s++) {
        const a = heap[vIdx];
        await sleep(40);
        const b = heap[vIdx];
        before.push(b - a);
      }

      heap[gIdx] = originalG * expectedFactor;
      await sleep(60);

      const after = [];
      for (let s = 0; s < 8; s++) {
        const a = heap[vIdx];
        await sleep(40);
        const b = heap[vIdx];
        after.push(b - a);
      }

      heap[gIdx] = originalG;

      const score = scoreGravityCandidate(before, after, expectedFactor);
      if (!best || score > best.score) best = { vIdx, gIdx, baseline: originalG, score };
      if (best && best.score > 0.78) break; // good enough
    }

    if (!best || best.score < 0.25) {
      updateStatus({
        gravityStatus:
          "Detection didn’t lock on confidently. Try again while steadily moving (not paused / menu).",
      });
      return;
    }

    state.gravity.detected = true;
    state.gravity.heapIndex = best.gIdx;
    state.gravity.baseline = best.baseline;
    saveState(state);
    updateStatus({
      gravityStatus: `Detected! gravityAcc @ HEAPF32[${best.gIdx}] baseline=${fmt(best.baseline, 3)} (score=${fmt(
        best.score,
        2
      )}).`,
    });

    await detectPhysicsFromGravity(best.gIdx);

    // Apply current multipliers immediately.
    applyGravityAndPhysics();
  }

  function isFinitePlausibleFloat(v) {
    return Number.isFinite(v) && Math.abs(v) <= 5000;
  }

  async function detectPhysicsFromGravity(gravityIdx) {
    const module = getModule();
    const heap = module && module.HEAPF32;
    if (!heap) return;
    const g = gravityIdx;

    // Guess vSpeed adjacent to gravity.
    const candidates = [g - 1, g + 1, g - 2, g + 2].filter((i) => i >= 0 && i < heap.length);
    let vSpeedIndex = null;
    let bestDelta = 0;
    for (const i of candidates) {
      const a = heap[i];
      if (!isFinitePlausibleFloat(a)) continue;
      await sleep(45);
      const b = heap[i];
      const d = Math.abs(b - a);
      if (d > bestDelta) {
        bestDelta = d;
        vSpeedIndex = i;
      }
    }
    if (!Number.isInteger(vSpeedIndex)) vSpeedIndex = isFinitePlausibleFloat(heap[g - 1]) ? g - 1 : g + 1;

    // Scan backwards from just before vSpeed for the last contiguous run of finite floats (likely config fields),
    // stopping at NaNs/inf/very large pointer-like values.
    const scanStart = Math.min(g, vSpeedIndex ?? g) - 1;
    let end = scanStart;
    while (end > 8 && !isFinitePlausibleFloat(heap[end])) end -= 1;
    let start = end;
    while (start > 8 && isFinitePlausibleFloat(heap[start - 1])) start -= 1;
    const runLen = end - start + 1;

    const pickFirstInRange = (from, to, min, max, afterIdx = null) => {
      for (let i = from; i <= to; i++) {
        if (afterIdx !== null && i <= afterIdx) continue;
        const v = heap[i];
        if (!Number.isFinite(v)) continue;
        if (v >= min && v <= max) return i;
      }
      return null;
    };
    const pickLastInRange = (from, to, min, max) => {
      for (let i = to; i >= from; i--) {
        const v = heap[i];
        if (!Number.isFinite(v)) continue;
        if (v >= min && v <= max) return i;
      }
      return null;
    };

    let baseMoveSpeedIndex = null;
    let speedAccelerationIndex = null;
    let rotationSpeedIndex = null;
    let jumpSpeedIndex = null;

    if (runLen >= 5 && runLen <= 32) {
      // Heuristics:
      // - jumpSpeed is usually near the end of the run (right before pointer fields), and is a positive float.
      // - baseMoveSpeed near start.
      baseMoveSpeedIndex = pickFirstInRange(start, end, 0.5, 160);
      speedAccelerationIndex = pickFirstInRange(start, end, 0.0001, 20, baseMoveSpeedIndex);
      rotationSpeedIndex = pickFirstInRange(start, end, 0.01, 120, speedAccelerationIndex);
      jumpSpeedIndex = pickLastInRange(start, end, 0.5, 200);
    }

    // Store baselines.
    const baseline = {};
    const storeBase = (key, idx) => {
      if (!Number.isInteger(idx) || idx < 0 || idx >= heap.length) return;
      const v = heap[idx];
      if (!Number.isFinite(v)) return;
      baseline[key] = v;
    };
    storeBase("baseMoveSpeed", baseMoveSpeedIndex);
    storeBase("speedAcceleration", speedAccelerationIndex);
    storeBase("rotationSpeed", rotationSpeedIndex);
    storeBase("jumpSpeed", jumpSpeedIndex);

    state.physics.detected = !!(
      Number.isInteger(baseMoveSpeedIndex) ||
      Number.isInteger(speedAccelerationIndex) ||
      Number.isInteger(rotationSpeedIndex) ||
      Number.isInteger(jumpSpeedIndex)
    );
    state.physics.vSpeedIndex = vSpeedIndex ?? null;
    state.physics.baseMoveSpeedIndex = baseMoveSpeedIndex;
    state.physics.speedAccelerationIndex = speedAccelerationIndex;
    state.physics.rotationSpeedIndex = rotationSpeedIndex;
    state.physics.jumpSpeedIndex = jumpSpeedIndex;
    state.physics.baseline = baseline;
    saveState(state);

    updateStatus({
      physicsStatus: state.physics.detected
        ? `Detected physics near gravity. baseMoveSpeed=${baseMoveSpeedIndex} jumpSpeed=${jumpSpeedIndex} rot=${rotationSpeedIndex} accel=${speedAccelerationIndex}`
        : "Physics detection failed (gravity detected, but couldn't infer other fields).",
    });
  }

  function onKeyDown(e) {
    if (e.repeat) return;
    const key = String(e.key || "");
    if (key === "Insert" || key === "F2") {
      e.preventDefault();
      setOpen(!state.open);
    }
  }

  function init() {
    ensureRoot();
    document.addEventListener("keydown", onKeyDown, { capture: true });
    // Keep status fresh while Unity loads.
    const t = setInterval(() => {
      ensureRoot();
      updateStatus();
      if (getUnity()) clearInterval(t);
    }, 350);
  }

  // Expose small API for index.html to call once Unity is initialized.
  window.SnowRiderMods = {
    onUnityReady(gi) {
      unityInstance = gi;
      unityModule = gi.Module;
      hookUnityLogging();
      ensureRoot();
      updateStatus({ gravityStatus: "Unity ready. Start a run, then click Auto-detect physics." });
      // Re-apply persisted gravity if we already detected a pointer in a prior session.
      applyGravityAndPhysics();
      if (!enforceTimer) {
        enforceTimer = setInterval(() => {
          // Re-apply silently so gameplay updates can't undo our values.
          applyGravityAndPhysics(false, true);
        }, 250);
      }
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  function refreshObjectDatalists() {
    // legacy no-op (we removed SendMessage UI).
  }
})();
