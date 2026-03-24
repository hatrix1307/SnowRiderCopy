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
      gravityMultiplier: 1,
      speedMultiplier: 1,
      send: {
        speedObject: "SlowMotion",
        speedMethod: "setSpeed",
      },
      gravity: {
        detected: false,
        heapIndex: null, // index in HEAPF32 (not bytes)
        baseline: null,
      },
    };

  let unityInstance = null;
  let unityModule = null;
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
              <div class="sr-mm-value" id="sr-mm-grav-val">x${fmt(state.gravityMultiplier, 2)}</div>
            </div>
            <input id="sr-mm-grav" type="range" min="0.2" max="3" step="0.05" value="${state.gravityMultiplier}">
            <div class="sr-mm-actions" style="margin-top:10px;">
              <button class="sr-mm-btn sr-mm-primary" id="sr-mm-detect-grav">Detect gravity (experimental)</button>
              <button class="sr-mm-btn" id="sr-mm-reset-grav">Reset</button>
            </div>
            <div class="sr-mm-status" id="sr-mm-grav-status" style="margin-top:8px;"></div>
          </div>

          <div class="sr-mm-section">
            <h3>Speed</h3>
            <div class="sr-mm-row">
              <label for="sr-mm-speed">Speed multiplier</label>
              <div class="sr-mm-value" id="sr-mm-speed-val">x${fmt(state.speedMultiplier, 2)}</div>
            </div>
            <input id="sr-mm-speed" type="range" min="0.25" max="3" step="0.05" value="${state.speedMultiplier}">
            <div class="sr-mm-actions" style="margin-top:10px;">
              <button class="sr-mm-btn sr-mm-primary" id="sr-mm-apply-speed">Apply</button>
            </div>
            <div class="sr-mm-status" id="sr-mm-speed-status" style="margin-top:8px;"></div>
            <details class="sr-mm-advanced" style="margin-top:8px;">
              <summary>Advanced (object/method)</summary>
              <div class="sr-mm-adv-grid">
                <div>
                  <input id="sr-mm-speed-object" list="sr-mm-objects" type="text" placeholder="GameObject" value="${escapeHtml(
                  state.send.speedObject
                )}">
                </div>
                <div>
                  <input id="sr-mm-speed-method" type="text" placeholder="Method" value="${escapeHtml(
                  state.send.speedMethod
                )}">
                </div>
              </div>
              <datalist id="sr-mm-objects"></datalist>
              <div class="sr-mm-actions" style="margin-top:10px;">
                <button class="sr-mm-btn" id="sr-mm-use-sledgephysics" type="button">Use SledgePhysics</button>
              </div>
              <div class="sr-mm-status" style="margin-top:8px;">
                Tries <code>SendMessage(object, method, number)</code>. If it does nothing, the game may not expose a speed hook.
              </div>
            </details>
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
      state.gravityMultiplier = Number(gravSlider.value);
      document.getElementById("sr-mm-grav-val").textContent = `x${fmt(state.gravityMultiplier, 2)}`;
      saveState(state);
      applyGravity();
    });

    document.getElementById("sr-mm-detect-grav").addEventListener("click", async () => {
      await detectGravityInteractive();
    });

    document.getElementById("sr-mm-reset-grav").addEventListener("click", () => {
      state.gravityMultiplier = 1;
      gravSlider.value = String(state.gravityMultiplier);
      document.getElementById("sr-mm-grav-val").textContent = `x${fmt(state.gravityMultiplier, 2)}`;
      saveState(state);
      applyGravity(true);
    });

    const speedSlider = document.getElementById("sr-mm-speed");
    speedSlider.addEventListener("input", () => {
      state.speedMultiplier = Number(speedSlider.value);
      document.getElementById("sr-mm-speed-val").textContent = `x${fmt(state.speedMultiplier, 2)}`;
      saveState(state);
    });

    document.getElementById("sr-mm-apply-speed").addEventListener("click", () => applySpeed());

    document.getElementById("sr-mm-speed-object").addEventListener("change", (e) => {
      state.send.speedObject = String(e.target.value || "").trim();
      saveState(state);
    });
    document.getElementById("sr-mm-speed-method").addEventListener("change", (e) => {
      state.send.speedMethod = String(e.target.value || "").trim();
      saveState(state);
    });

    document.getElementById("sr-mm-use-sledgephysics").addEventListener("click", () => {
      state.send.speedObject = "SledgePhysics";
      const el = document.getElementById("sr-mm-speed-object");
      if (el) el.value = "SledgePhysics";
      saveState(state);
      updateStatus();
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
    const speedStatus = document.getElementById("sr-mm-speed-status");
    const debugStatus = document.getElementById("sr-mm-debug-status");
    if (!gravStatus || !speedStatus) return;

    const gi = getUnity();
    if (!gi) {
      gravStatus.textContent = "Waiting for Unity to finish loading…";
      speedStatus.textContent = "Waiting for Unity to finish loading…";
      if (debugStatus) debugStatus.textContent = "Unity not ready yet.";
      return;
    }

    if (!state.gravity.detected) {
      gravStatus.textContent =
        extra.gravityStatus ||
        "Not detected yet. Click “Detect gravity” while you’re in a run (when the sled is moving).";
    } else {
      gravStatus.textContent =
        extra.gravityStatus ||
        `Detected. gravityAcc @ HEAPF32[${state.gravity.heapIndex}] baseline=${fmt(state.gravity.baseline, 3)}.`;
    }

    speedStatus.textContent =
      extra.speedStatus ||
      `Hook: ${state.send.speedObject}.${state.send.speedMethod} (SendMessage).`;

    if (debugStatus) {
      const last = logBuffer.length ? logBuffer[logBuffer.length - 1].line : "";
      debugStatus.textContent = extra.debugStatus || (last ? `Last log: ${last}` : "No Unity logs captured yet.");
    }
  }

  async function applySpeed() {
    ensureRoot();
    const result = await sendMessageChecked(
      state.send.speedObject,
      state.send.speedMethod,
      Number(state.speedMultiplier)
    );
    updateStatus({
      speedStatus: result.ok
        ? `Sent: ${state.send.speedObject}.${state.send.speedMethod}(${fmt(state.speedMultiplier, 2)})`
        : `Failed: ${result.reason}`,
    });
  }

  function applyGravity(forceReset = false) {
    if (!state.gravity.detected) return;
    const module = getModule();
    if (!module || !module.HEAPF32) return;

    const idx = state.gravity.heapIndex;
    const baseline = state.gravity.baseline;
    if (!Number.isInteger(idx) || !Number.isFinite(baseline)) return;
    if (idx < 0 || idx >= module.HEAPF32.length) return;

    const mult = forceReset ? 1 : clamp(Number(state.gravityMultiplier), 0.05, 5);
    module.HEAPF32[idx] = baseline * mult;
    updateStatus({
      gravityStatus: `Applied gravity: ${fmt(module.HEAPF32[idx], 3)} (x${fmt(mult, 2)})`,
    });
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

  async function detectGravityInteractive() {
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

    // Apply current multiplier immediately.
    applyGravity();
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
      updateStatus({ gravityStatus: "Unity ready. Click Detect gravity while in a run." });
      // Re-apply persisted gravity if we already detected a pointer in a prior session.
      applyGravity();
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  function refreshObjectDatalists() {
    const dl = document.getElementById("sr-mm-objects");
    if (!dl) return;
    const current = new Set(Array.from(dl.querySelectorAll("option")).map((o) => o.value));
    // Add a few common names + discovered names.
    const base = [
      "SledgePhysics",
      "GenerationControl",
      "ServerManager",
      "GameManager",
      "Canvas",
      "PlayCanvas",
      "Reporter",
      "Loader",
      "RewardLoader",
    ];
    for (const name of base) knownObjects.add(name);
    const names = Array.from(knownObjects).sort((a, b) => a.localeCompare(b)).slice(0, 120);
    for (const name of names) {
      if (current.has(name)) continue;
      const opt = document.createElement("option");
      opt.value = name;
      dl.appendChild(opt);
    }
  }
})();
