/* Dead Reckoning — client.
   The map is never given to us by the model. We derive it the way a navigator
   without landmarks does: by logging which way we went, and trusting the log. */

(() => {
  "use strict";

  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const DIRV = {
    north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
    up: [1, -1], down: [-1, 1], in: [1, 1], out: [-1, -1],
  };
  const OPP = {
    north: "south", south: "north", east: "west", west: "east",
    up: "down", down: "up", in: "out", out: "in",
  };
  const ABBR = {
    north: "N", south: "S", east: "E", west: "W",
    up: "up", down: "dn", in: "in", out: "out",
  };

  const SEEDS = [
    "A drowned observatory, still transmitting",
    "The inside of a stopped clock the size of a city",
    "A night train with no driver and one other passenger",
    "The last library, staffed by things that were once librarians",
    "A greenhouse on a comet, three hundred years untended",
  ];

  const S = {
    seed: null,
    history: [],
    rooms: Object.create(null),   // id -> {id, name, x, y, exits:[dir]}
    cells: Object.create(null),   // "x,y" -> id
    edges: [],                    // {a, b, dir}  dir points a -> b
    curId: null,
    inventory: [],
    fresh: new Set(),
    busy: false,
    over: false,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    setup: $("setup"), seeds: $("seeds"), seedForm: $("seedForm"), seedInput: $("seedInput"),
    beginBtn: $("beginBtn"), seedline: $("seedline"),
    stat: $("stat"), statText: $("statText"), game: $("game"), log: $("log"),
    map: $("map"), chartCount: $("chartCount"), exits: $("exits"), pack: $("pack"),
    consoleEl: $("console"), sugg: $("sugg"), form: $("form"), cmd: $("cmd"), send: $("send"),
    imgToggle: $("imgToggle"),
  };

  let canImage = false;
  let imagesOn = true;
  try { imagesOn = localStorage.getItem("dr.images") !== "off"; } catch {}

  function syncToggle() {
    els.imgToggle.hidden = !canImage;
    els.imgToggle.textContent = imagesOn ? "Illustrations on" : "Illustrations off";
    els.imgToggle.setAttribute("aria-pressed", String(imagesOn));
    els.imgToggle.classList.toggle("ok", imagesOn);
  }
  els.imgToggle.addEventListener("click", () => {
    imagesOn = !imagesOn;
    try { localStorage.setItem("dr.images", imagesOn ? "on" : "off"); } catch {}
    syncToggle();
  });

  /* ------------------------------------------------------------ map model */

  function freeCell(x, y) {
    if (!S.cells[x + "," + y]) return [x, y];
    for (let ring = 1; ring <= 10; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          if (!S.cells[x + dx + "," + (y + dy)]) return [x + dx, y + dy];
        }
      }
    }
    return [x, y];
  }

  function place(id, name, fromId, dir) {
    const known = S.rooms[id];
    if (known) { known.name = name || known.name; return known; }
    let bx = 0, by = 0;
    const from = fromId ? S.rooms[fromId] : null;
    if (from) {
      const v = (dir && DIRV[dir]) || [0, -1];
      bx = from.x + v[0];
      by = from.y + v[1];
    }
    const [x, y] = freeCell(bx, by);
    const room = { id, name, x, y, exits: [] };
    S.rooms[id] = room;
    S.cells[x + "," + y] = id;
    return room;
  }

  const hasEdge = (id, dir) =>
    S.edges.some((e) => (e.a === id && e.dir === dir) || (e.b === id && OPP[e.dir] === dir));

  /* ---------------------------------------------------------- map drawing */

  const ctx = els.map.getContext("2d");
  let pulse = 0;

  function drawMap() {
    const wrap = els.map.parentElement;
    const cssW = Math.max(180, wrap.clientWidth);
    const cssH = Math.max(190, Math.min(cssW * 0.85, 300));
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (els.map.width !== Math.round(cssW * dpr) || els.map.height !== Math.round(cssH * dpr)) {
      els.map.width = Math.round(cssW * dpr);
      els.map.height = Math.round(cssH * dpr);
      els.map.style.height = cssH + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const css = getComputedStyle(document.documentElement);
    const c = (n) => css.getPropertyValue(n).trim();
    const COL = {
      bg: c("--bg"), line: c("--line"), line2: c("--line-2"),
      accent: c("--accent"), dim: c("--dim"), faint: c("--faint"),
    };

    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    const rooms = Object.values(S.rooms);
    if (!rooms.length) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const r of rooms) {
      minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x);
      minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y);
    }
    const spanX = maxX - minX + 1, spanY = maxY - minY + 1;
    const pad = 16;
    const cell = Math.max(15, Math.min(58,
      Math.min((cssW - pad * 2) / (spanX + 0.8), (cssH - pad * 2) / (spanY + 0.8))));
    const gw = spanX * cell, gh = spanY * cell;
    const ox = (cssW - gw) / 2 - minX * cell + cell / 2;
    const oy = (cssH - gh) / 2 - minY * cell + cell / 2;
    const px = (r) => [ox + r.x * cell, oy + r.y * cell];

    const nw = Math.max(11, cell * 0.62), nh = Math.max(8, cell * 0.42);
    const named = cell >= 30;

    /* corridors */
    ctx.strokeStyle = COL.line2;
    ctx.lineWidth = 1.1;
    for (const e of S.edges) {
      const a = S.rooms[e.a], b = S.rooms[e.b];
      if (!a || !b) continue;
      const p = px(a), q = px(b);
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
    }

    /* ways out we have seen but not taken */
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = COL.line2;
    ctx.lineWidth = 1;
    for (const r of rooms) {
      const p = px(r);
      for (const d of r.exits) {
        if (hasEdge(r.id, d) || !DIRV[d]) continue;
        const v = DIRV[d];
        const len = Math.hypot(v[0], v[1]);
        const ux = v[0] / len, uy = v[1] / len;
        const x0 = p[0] + ux * nw * 0.6, y0 = p[1] + uy * nh * 0.75;
        const x1 = p[0] + ux * cell * 0.42, y1 = p[1] + uy * cell * 0.42;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(x1, y1, 2, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([2, 3]);
      }
    }
    ctx.setLineDash([]);

    /* chambers */
    ctx.font = "400 8.5px 'DM Mono', ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const r of rooms) {
      const [x, y] = px(r);
      const here = r.id === S.curId;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - nw / 2, y - nh / 2, nw, nh, 2);
      else ctx.rect(x - nw / 2, y - nh / 2, nw, nh);

      if (here) {
        ctx.fillStyle = COL.accent;
        ctx.fill();
        if (!REDUCED) {
          ctx.strokeStyle = COL.accent;
          ctx.globalAlpha = 0.35 * (0.5 + 0.5 * Math.sin(pulse / 420));
          ctx.lineWidth = 3.5;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      } else {
        ctx.fillStyle = COL.bg;
        ctx.fill();
        ctx.strokeStyle = COL.line2;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (named || here) {
        const label = r.name.length > 15 ? r.name.slice(0, 14) + "…" : r.name;
        ctx.fillStyle = here ? COL.accent : COL.faint;
        ctx.fillText(label, x, y + nh / 2 + 8);
      }
    }
  }

  // The map is static between turns; it only redraws for the "you are here"
  // pulse, so 20fps is plenty and leaves the CPU alone.
  let lastDraw = 0;
  function tick(t) {
    pulse = t;
    if (!REDUCED && S.curId && t - lastDraw > 50) {
      lastDraw = t;
      drawMap();
    }
    requestAnimationFrame(tick);
  }

  /* -------------------------------------------------------------- panels */

  function renderExits(exits) {
    els.exits.innerHTML = "";
    if (!exits.length) {
      const p = document.createElement("div");
      p.className = "exit";
      p.style.cursor = "default";
      p.textContent = "no way out that you can see";
      els.exits.appendChild(p);
      return;
    }
    for (const e of exits) {
      const b = document.createElement("button");
      b.className = "exit";
      b.type = "button";
      b.disabled = S.busy || S.over;
      b.innerHTML = `<span class="d"></span><span class="l"></span>`;
      b.firstChild.textContent = ABBR[e.dir] || e.dir;
      b.lastChild.textContent = e.label;
      b.addEventListener("click", () => act(`go ${e.dir}`));
      els.exits.appendChild(b);
    }
  }

  function renderPack() {
    els.pack.innerHTML = "";
    if (!S.inventory.length) {
      const li = document.createElement("li");
      li.className = "none";
      li.textContent = "nothing";
      els.pack.appendChild(li);
      return;
    }
    for (const item of S.inventory) {
      const li = document.createElement("li");
      li.textContent = item;
      if (S.fresh.has(item)) li.className = "fresh";
      els.pack.appendChild(li);
    }
  }

  function renderSugg(list) {
    els.sugg.innerHTML = "";
    for (const s of list.slice(0, 3)) {
      const b = document.createElement("button");
      b.className = "chip";
      b.type = "button";
      b.textContent = s;
      b.disabled = S.busy || S.over;
      b.addEventListener("click", () => act(s));
      els.sugg.appendChild(b);
    }
  }

  /* ------------------------------------------------------------ transcript */

  let skipReveal = false;
  els.log.addEventListener("click", () => { skipReveal = true; });

  const scrollLog = () => { els.log.scrollTop = els.log.scrollHeight; };

  function addEntry(action) {
    const d = document.createElement("article");
    d.className = "entry";
    if (action) {
      const a = document.createElement("div");
      a.className = "did";
      a.textContent = action;
      d.appendChild(a);
    }
    const place = document.createElement("div");
    place.className = "place";
    const box = document.createElement("div");
    box.className = "prose caret";
    d.append(place, box);
    els.log.appendChild(d);
    scrollLog();
    return { root: d, place, box };
  }

  /* ---------------------------------------------------------- illustration */

  // roomId -> data URL, so a room drawn once is never redrawn.
  const plates = new Map();
  const pending = new Set();

  async function illustrate(entry, roomId, scene) {
    if (!imagesOn || !canImage || !roomId || !scene) return;

    const fig = document.createElement("figure");
    fig.className = "plate loading";
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    fig.appendChild(img);
    entry.root.insertBefore(fig, entry.place);
    scrollLog();

    const paint = (src) => {
      img.addEventListener("load", () => { fig.classList.remove("loading"); scrollLog(); }, { once: true });
      img.src = src;
    };

    if (plates.has(roomId)) return paint(plates.get(roomId));
    if (pending.has(roomId)) { fig.remove(); return; }
    pending.add(roomId);

    try {
      const r = await fetch("/api/image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed: S.seed, roomId, scene }),
      }).then((x) => x.json());
      if (r.image) {
        plates.set(roomId, r.image);
        paint(r.image);
      } else {
        fig.className = "plate failed";
        fig.textContent = r.error || "Could not draw this room.";
        scrollLog();
      }
    } catch {
      fig.remove();
    } finally {
      pending.delete(roomId);
    }
  }

  function typeInto(el, text) {
    return new Promise((done) => {
      if (REDUCED) { el.textContent = text; scrollLog(); return done(); }
      el.classList.add("caret");
      let i = 0, last = performance.now(), acc = 0;
      const step = (now) => {
        acc += ((now - last) / 1000) * 380;
        last = now;
        if (acc >= 1) {
          i = Math.min(text.length, i + Math.floor(acc));
          acc -= Math.floor(acc);
          el.textContent = text.slice(0, i);
          scrollLog();
        }
        if (i < text.length && !skipReveal) requestAnimationFrame(step);
        else {
          el.textContent = text;
          el.classList.remove("caret");
          scrollLog();
          done();
        }
      };
      requestAnimationFrame(step);
    });
  }

  async function reveal(box, text) {
    box.classList.remove("caret");
    skipReveal = false;
    const paras = String(text || "").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    if (!paras.length) paras.push("…");
    for (const para of paras) {
      const p = document.createElement("p");
      box.appendChild(p);
      await typeInto(p, para);
    }
  }

  /* ------------------------------------------------------------- the turn */

  function stateNote() {
    const known = Object.values(S.rooms).map((r) => `${r.id}="${r.name}"`).join(", ");
    const inv = S.inventory.length ? S.inventory.join(", ") : "nothing";
    return `\n\n[continuity: currently in room "${S.curId || "—"}". carrying: ${inv}. rooms already named: ${known || "none"}. reuse those ids and names exactly when the player returns.]`;
  }

  function setBusy(on) {
    S.busy = on;
    els.consoleEl.classList.toggle("thinking", on);
    els.cmd.disabled = on || S.over;
    els.send.disabled = on || S.over;
    for (const b of els.sugg.querySelectorAll("button")) b.disabled = on || S.over;
    for (const b of els.exits.querySelectorAll("button")) b.disabled = on || S.over;
  }

  async function act(rawAction) {
    if (S.busy || S.over) return;
    const action = rawAction.trim();
    if (!action) return;

    setBusy(true);
    els.cmd.value = "";
    els.sugg.innerHTML = "";
    const entry = addEntry(S.history.length ? action : null);

    let data;
    try {
      const res = await fetch("/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          seed: S.seed,
          history: S.history.slice(-18),
          action: action + stateNote(),
        }),
      });
      data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `server ${res.status}`);
    } catch (err) {
      entry.root.classList.add("err");
      entry.box.classList.remove("caret");
      const p = document.createElement("p");
      p.textContent = err.message || "The connection failed.";
      entry.box.appendChild(p);
      scrollLog();
      setBusy(false);
      return;
    }

    const t = data.turn;
    const before = S.curId;

    /* move the pin */
    const dir = DIRV[t.moved] ? t.moved : null;
    if (t.room && t.room.id && t.room.id !== S.curId) {
      place(t.room.id, t.room.name, S.curId, dir);
      if (S.curId) S.edges.push({ a: S.curId, b: t.room.id, dir: dir || "in" });
      S.curId = t.room.id;
    }
    const here = S.rooms[S.curId];
    if (here) here.exits = (t.exits || []).map((e) => e.dir);

    /* the pack */
    S.fresh.clear();
    for (const item of t.inventoryRemove || []) {
      const i = S.inventory.findIndex((x) => x.toLowerCase() === String(item).toLowerCase());
      if (i >= 0) S.inventory.splice(i, 1);
    }
    for (const item of t.inventoryAdd || []) {
      if (!S.inventory.some((x) => x.toLowerCase() === String(item).toLowerCase())) {
        S.inventory.push(item);
        S.fresh.add(item);
      }
    }

    /* the mood */
    const hue = Number(t.mood && t.mood.hue);
    if (Number.isFinite(hue)) document.documentElement.style.setProperty("--h", String(((hue % 360) + 360) % 360));

    /* the record */
    S.history.push({ role: "user", text: action });
    S.history.push({
      role: "model",
      text: JSON.stringify({
        room: t.room, moved: t.moved, prose: t.prose, exits: t.exits, ending: t.ending,
      }),
    });

    entry.place.textContent = here ? here.name : "";
    els.chartCount.textContent = `${Object.keys(S.rooms).length} room${Object.keys(S.rooms).length === 1 ? "" : "s"}`;
    renderExits(t.exits || []);
    renderPack();
    drawMap();

    // Fire and forget — the picture arrives while the prose is still typing.
    if (S.curId !== before) illustrate(entry, S.curId, t.scene);

    await reveal(entry.box, t.prose || "");

    if (t.ending && t.ending !== "none") {
      S.over = true;
      endCard(t.ending);
    } else {
      renderSugg(t.suggestions || []);
    }
    setBusy(false);
    if (!S.over) els.cmd.focus();
  }

  function endCard(kind) {
    const titles = {
      escaped: "You got out",
      lost: "You did not get out",
      transformed: "You are not what walked in",
    };
    const card = document.createElement("div");
    card.className = "ending";
    const h = document.createElement("h2");
    h.textContent = titles[kind] || "It ends";
    const p = document.createElement("p");
    p.textContent = `${Object.keys(S.rooms).length} rooms charted over ${Math.floor(S.history.length / 2)} turns.`;
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = "Set out again";
    b.addEventListener("click", () => location.reload());
    card.append(h, p, b);
    els.log.appendChild(card);
    scrollLog();
  }

  /* ---------------------------------------------------------------- start */

  function begin(seed) {
    S.seed = seed;
    els.seedline.textContent = seed;
    els.setup.hidden = true;
    els.game.hidden = false;
    els.consoleEl.hidden = false;
    drawMap();
    act("Begin. Put me somewhere in this place and tell me what I can see.");
  }

  for (let i = 0; i < SEEDS.length; i++) {
    const b = document.createElement("button");
    b.className = "seed";
    b.type = "button";
    b.innerHTML = `<span class="n"></span><span class="t"></span>`;
    b.firstChild.textContent = String(i + 1).padStart(2, "0");
    b.lastChild.textContent = SEEDS[i];
    b.addEventListener("click", () => begin(SEEDS[i]));
    els.seeds.appendChild(b);
  }

  els.seedForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = els.seedInput.value.trim();
    if (v) begin(v);
  });

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    act(els.cmd.value);
  });

  addEventListener("resize", drawMap);
  requestAnimationFrame(tick);

  /* ------------------------------------------------------------------ key */

  const K = {
    card: $("keyCard"), title: $("keyTitle"), form: $("keyForm"), input: $("keyInput"),
    peek: $("keyPeek"), save: $("keySave"), remember: $("keyRemember"), msg: $("keyMsg"),
    have: $("keyHave"), haveText: $("keyHaveText"), forget: $("keyForget"),
    dlg: $("keyDlg"), dlgX: $("keyDlgX"), slotSetup: $("slotSetup"), slotDialog: $("slotDialog"),
  };
  let hasKey = false;

  function say(text, good) {
    K.msg.hidden = !text;
    K.msg.textContent = text || "";
    K.msg.classList.toggle("good", !!good);
  }

  function applyStatus(s) {
    hasKey = !!s.ok;
    canImage = !!(s.ok && s.imageModel);
    syncToggle();
    els.stat.className = "stat " + (s.ok ? "ok" : "bad");
    els.statText.textContent = s.ok ? s.model : s.reason === "no-key" ? "add key" : "key problem";

    els.beginBtn.disabled = !s.ok;
    els.seedInput.disabled = !s.ok;
    for (const b of els.seeds.querySelectorAll("button")) b.disabled = !s.ok;

    K.card.hidden = false;
    K.form.hidden = !!s.ok;
    K.have.hidden = !s.ok;
    K.title.textContent = s.ok ? "Gemini API key" : "Add your Gemini API key";
    if (s.ok) K.haveText.textContent = `key ${s.hint} · ${s.source} · ${s.model}`;

    // Live in the setup screen while there's no key and no run under way;
    // otherwise the card is only reachable through the header dialog.
    const target = K.dlg.open || s.ok || S.seed ? K.slotDialog : K.slotSetup;
    target.appendChild(K.card);

    if (!s.ok && s.reason === "model") say(s.detail || "That key did not work.");
  }

  K.peek.addEventListener("click", () => {
    const reveal = K.input.type === "password";
    K.input.type = reveal ? "text" : "password";
    K.peek.textContent = reveal ? "Hide" : "Show";
  });

  K.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = K.input.value.trim();
    if (!key) return say("Paste a key first.");
    K.save.disabled = true;
    say("Checking with Google…", true);
    try {
      const s = await fetch("/api/key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, remember: K.remember.checked }),
      }).then((r) => r.json());
      if (!s.ok) return say(s.detail || "That key was not accepted.");
      K.input.value = "";
      K.input.type = "password";
      K.peek.textContent = "Show";
      say("");
      applyStatus(s);
      if (K.dlg.open) K.dlg.close();
    } catch {
      say("Could not reach the local server. Is it still running?");
    } finally {
      K.save.disabled = false;
    }
  });

  K.forget.addEventListener("click", async () => {
    try {
      applyStatus(await fetch("/api/key/forget", { method: "POST" }).then((r) => r.json()));
      say("Key removed.");
    } catch {
      say("Could not reach the local server.");
    }
  });

  els.stat.addEventListener("click", () => {
    K.slotDialog.appendChild(K.card);
    K.dlg.showModal();
    if (!hasKey) K.input.focus();
  });
  K.dlgX.addEventListener("click", () => K.dlg.close());
  K.dlg.addEventListener("close", () => {
    if (!hasKey && !S.seed) K.slotSetup.appendChild(K.card);
  });

  fetch("/api/status")
    .then((r) => r.json())
    .then(applyStatus)
    .catch(() => {
      els.stat.className = "stat bad";
      els.statText.textContent = "server down";
    });
})();
