// Dead Reckoning — local server.
//
// Holds the Gemini API key server-side and proxies model calls, so the key is
// never kept in the browser. The key can be typed into the app itself, or come
// from a GEMINI_API_KEY environment variable, or from .env beside this file.
//
// No dependencies; needs Node 18+ for global fetch.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const ENV_PATH = join(ROOT, ".env");
const PORT = Number(process.env.PORT) || 4700;
const API = "https://generativelanguage.googleapis.com/v1beta";

/* ------------------------------------------------------------------ key */

// Entered in the app this session. Beats the environment and .env so that
// typing a new key in the UI actually takes effect without a restart.
let runtimeKey = null;

function fileKey() {
  if (!existsSync(ENV_PATH)) return null;
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  return null;
}

function currentKey() {
  if (runtimeKey) return runtimeKey;
  const env = process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim();
  if (env) return env;
  return fileKey();
}

function keySource() {
  if (runtimeKey) return "entered in the app";
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) return "environment variable";
  if (fileKey()) return ".env file";
  return null;
}

// Only ever show the tail, so the page can confirm which key is loaded
// without the full value travelling back over the wire.
const hint = (k) => (k && k.length > 8 ? `…${k.slice(-4)}` : k ? "…" : null);

// Never let a key escape inside an error string sent to the browser.
function scrub(s) {
  let t = String(s);
  for (const k of [runtimeKey, process.env.GEMINI_API_KEY, fileKey()]) {
    if (k && k.trim()) t = t.split(k.trim()).join("<key>");
  }
  return t;
}

function persistKey(key) {
  let lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  let found = false;
  lines = lines
    .map((l) => {
      if (!/^\s*(?:export\s+)?GEMINI_API_KEY\s*=/.test(l)) return l;
      found = true;
      return key === null ? null : `GEMINI_API_KEY=${key}`;
    })
    .filter((l) => l !== null);
  if (!found && key !== null) {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`GEMINI_API_KEY=${key}`);
  }
  let out = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  if (out.trim() && !out.endsWith("\n")) out += "\n";
  writeFileSync(ENV_PATH, out, "utf8");
}

/* ---------------------------------------------------------------- model */

// Model ids move fast, so rather than hard-coding one that may be retired,
// ask the API what this key can actually use and score the candidates.
let model = null;
let modelForKey = null;

function score(id) {
  if (/embedding|aqa|imagen|veo|tts|image|audio|live|vision/.test(id)) return -1;
  let s = 0;
  if (/flash-latest/.test(id)) s += 140;
  else if (/pro-latest/.test(id)) s += 120;
  else if (/flash/.test(id) && !/lite/.test(id)) s += 100;
  else if (/flash.*lite/.test(id)) s += 55;
  else if (/pro/.test(id)) s += 80;
  else return -1;
  const v = id.match(/gemini-(\d+(?:\.\d+)?)/);
  if (v) s += parseFloat(v[1]) * 8;
  if (/preview|exp|thinking/.test(id)) s -= 30;
  return s;
}

let catalogue = null;
let catalogueForKey = null;

async function listModels(key) {
  if (catalogue && catalogueForKey === key) return catalogue;
  const r = await fetch(`${API}/models?key=${encodeURIComponent(key)}&pageSize=200`);
  if (!r.ok) {
    let msg = `Google rejected the key (HTTP ${r.status}).`;
    try {
      const e = JSON.parse(await r.text());
      if (e?.error?.message) msg = e.error.message;
    } catch {}
    throw new Error(scrub(msg));
  }
  const { models = [] } = await r.json();
  catalogue = models.map((m) => ({
    id: m.name.replace(/^models\//, ""),
    methods: m.supportedGenerationMethods || [],
  }));
  catalogueForKey = key;
  return catalogue;
}

async function pickModel(key) {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (model && modelForKey === key) return model;
  const usable = (await listModels(key))
    .filter((m) => m.methods.includes("generateContent"))
    .map((m) => ({ id: m.id, s: score(m.id) }))
    .filter((m) => m.s > 0)
    .sort((a, b) => b.s - a.s);
  if (!usable.length) throw new Error("That key has no text-generation model available to it.");
  model = usable[0].id;
  modelForKey = key;
  return model;
}

/* ---------------------------------------------------------------- images */

// Two different shapes of image API exist: Gemini's own image models answer
// generateContent with inline image parts, Imagen answers :predict. Find
// whichever this key has.
let imageModel = null;
let imageModelForKey = null;

function imageScore(id) {
  const v = id.match(/(\d+(?:\.\d+)?)/);
  const n = v ? parseFloat(v[1]) : 0;
  if (/gemini.*flash.*image/.test(id)) return 100 + n * 4;
  if (/gemini.*image/.test(id)) return 80 + n * 4;
  if (/^imagen-/.test(id)) return 50 + n * 4;
  return -1;
}

async function pickImageModel(key) {
  if (imageModel !== null && imageModelForKey === key) return imageModel;
  const found = (await listModels(key))
    .map((m) => {
      const s = imageScore(m.id);
      if (s < 0) return null;
      const mode = /^imagen-/.test(m.id) && m.methods.includes("predict")
        ? "imagen"
        : m.methods.includes("generateContent") ? "gen" : null;
      return mode ? { id: m.id, mode, s: s - (/preview|exp/.test(m.id) ? 10 : 0) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.s - a.s);
  imageModel = found[0] || null;
  imageModelForKey = key;
  return imageModel;
}

const STYLE =
  "Atmospheric painterly digital illustration, cinematic wide composition, " +
  "muted desaturated palette lit by one strong source, deep shadow, a sense of " +
  "scale and silence, detailed environment concept art. No text, no lettering, " +
  "no watermark, no figures unless the description names one.";

// seed|roomId -> data URL. Rooms are revisited constantly; never pay twice.
const images = new Map();

async function makeImage(key, seed, roomId, scene) {
  const slot = `${seed}|${roomId}`;
  if (images.has(slot)) return images.get(slot);

  const pick = await pickImageModel(key);
  if (!pick) throw new Error("That key has no image model available to it.");
  const prompt = `${scene}\n\nThis place is somewhere inside: ${seed}\n\n${STYLE}`;
  let dataUrl = null;
  let last = "the image model returned nothing";

  if (pick.mode === "imagen") {
    const r = await fetch(`${API}/models/${encodeURIComponent(pick.id)}:predict?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: "16:9" },
      }),
    });
    const raw = await r.text();
    if (!r.ok) {
      try { last = JSON.parse(raw)?.error?.message || last; } catch {}
      throw new Error(scrub(last));
    }
    const p = JSON.parse(raw)?.predictions?.[0];
    if (p?.bytesBase64Encoded) dataUrl = `data:${p.mimeType || "image/png"};base64,${p.bytesBase64Encoded}`;
  } else {
    // Some image models reject an IMAGE-only response; fall back to both.
    for (const responseModalities of [["IMAGE"], ["TEXT", "IMAGE"]]) {
      const r = await fetch(`${API}/models/${encodeURIComponent(pick.id)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseModalities },
        }),
      });
      const raw = await r.text();
      if (!r.ok) {
        try { last = JSON.parse(raw)?.error?.message || last; } catch {}
        continue;
      }
      const parts = JSON.parse(raw)?.candidates?.[0]?.content?.parts || [];
      const img = parts.find((p) => p.inlineData && p.inlineData.data);
      if (img) {
        dataUrl = `data:${img.inlineData.mimeType || "image/png"};base64,${img.inlineData.data}`;
        break;
      }
    }
  }

  if (!dataUrl) throw new Error(scrub(last));
  if (images.size > 120) images.delete(images.keys().next().value);
  images.set(slot, dataUrl);
  return dataUrl;
}

/* --------------------------------------------------------------- prompt */

const SYSTEM = (seed) => `You are the engine of a text adventure. The world is:

${seed}

Build that world and run it honestly. Rules:

PROSE. Second person, present tense. Two paragraphs, six to ten sentences in
total. Separate the paragraphs with a blank line.

Start by making the result of what the player just did unmistakable: what
happened, what it cost, whether it worked. If it failed, say plainly why. Then
place them — the shape and size of the space, what it is built from, what the
light is doing, what they can hear and smell, and the one detail that is wrong
or worth crossing the room for. End on something that invites a next move.

Name things exactly. Not "old machinery" but "a lathe, its bed furred with
rust". Not "a strange smell" but "wet limestone and burnt hair". If the player
has come back to a room they have been in before, say so in the first line and
say what has changed since they left.

Never break frame, never mention rules or models, never narrate the player's
feelings for them, never open with "You find yourself".

THREAD. Run one question through the whole story — something the player wants to
reach or find out. Establish it within the first three turns, refer back to it
as they go, and let their discoveries visibly add up. When something important
happens, connect it out loud to what came before. The player should always be
able to say what they are currently trying to do and why.

SCENE. Alongside the prose, write "scene": one sentence of pure visual
description of the room they are in now, for an illustrator who has read nothing
else — architecture, materials, light source, scale, the most striking object.
No story, no second person, no names. Keep it consistent every time the same
room is described.

WORLD. It is finite, consistent and physical. A room you have already described
keeps the same room.id and the same name forever; reuse them exactly when the
player returns. room.id is lowercase-kebab-case. Aim for a place of 12 to 25
rooms with genuine geography — dead ends, loops, a locked way onward.

MOVEMENT. "moved" is the compass direction the player actually travelled this
turn, or "none" if they stayed in the same room. This is how the map is drawn,
so it must be truthful: if the prose says they climbed a ladder, moved is "up".

EXITS. Every way out of the room they are in NOW, each with a short concrete
label — "a stairwell choked with cable", "a hatch, dogged shut". Include ways
out they can see but cannot yet use; say so in the label.

MOOD. mood.hue is an HSL hue from 0-359 matching how the scene feels. Cold,
drowned, electrical ~200. Fire, blood, alarm ~10. Rot and growth ~110. Dread and
the uncanny ~280. Sickly, chemical ~70. Change it when the scene turns.
mood.word is one lowercase adjective.

THINGS. Anything the player takes goes in inventoryAdd, exactly as you named it
in the prose. Anything spent, dropped, given or destroyed goes in
inventoryRemove. Objects should matter later.

SUGGESTIONS. Three imperative actions of two to four words that a curious player
would actually try here. Never include a bare compass direction — the exits
already cover those.

PLAY FAIR. Be generous with intent. If the player tries something inventive,
let it work, or let it fail in a way that teaches them something. Never reply
"you can't do that". Let them break things. Consequences are allowed to be
permanent.

ENDING. "none" until the story genuinely concludes. Do not rush it; a good run
runs 20+ turns. When it ends, end it properly in the prose.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    prose: { type: "STRING" },
    scene: { type: "STRING" },
    room: {
      type: "OBJECT",
      properties: { id: { type: "STRING" }, name: { type: "STRING" } },
      required: ["id", "name"],
    },
    moved: {
      type: "STRING",
      enum: ["north", "south", "east", "west", "up", "down", "in", "out", "none"],
    },
    exits: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          dir: {
            type: "STRING",
            enum: ["north", "south", "east", "west", "up", "down", "in", "out"],
          },
          label: { type: "STRING" },
        },
        required: ["dir", "label"],
      },
    },
    inventoryAdd: { type: "ARRAY", items: { type: "STRING" } },
    inventoryRemove: { type: "ARRAY", items: { type: "STRING" } },
    mood: {
      type: "OBJECT",
      properties: { hue: { type: "INTEGER" }, word: { type: "STRING" } },
      required: ["hue", "word"],
    },
    suggestions: { type: "ARRAY", items: { type: "STRING" } },
    ending: { type: "STRING", enum: ["none", "escaped", "lost", "transformed"] },
  },
  required: [
    "prose", "scene", "room", "moved", "exits",
    "inventoryAdd", "inventoryRemove", "mood", "suggestions", "ending",
  ],
};

/* ------------------------------------------------------------------ api */

async function takeTurn({ seed, history, action }) {
  const key = currentKey();
  const m = await pickModel(key);
  const contents = [];
  for (const h of history || []) {
    contents.push({
      role: h.role === "model" ? "model" : "user",
      parts: [{ text: String(h.text).slice(0, 6000) }],
    });
  }
  contents.push({ role: "user", parts: [{ text: String(action).slice(0, 600) }] });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  let res;
  try {
    res = await fetch(
      `${API}/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM(seed) }] },
          contents,
          generationConfig: {
            temperature: 1.05,
            topP: 0.95,
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
            responseSchema: SCHEMA,
          },
        }),
      }
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  if (!res.ok) {
    let msg = `Gemini returned ${res.status}`;
    try {
      const e = JSON.parse(raw);
      if (e?.error?.message) msg = e.error.message;
    } catch {}
    throw new Error(scrub(msg));
  }

  const data = JSON.parse(raw);
  const cand = data?.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) {
    const why = cand?.finishReason || data?.promptFeedback?.blockReason || "empty response";
    throw new Error(`The model returned nothing (${why}). Try rephrasing that action.`);
  }
  return { turn: JSON.parse(text), model: m };
}

/* --------------------------------------------------------------- server */

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function json(res, code, body) {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": b.length,
    "cache-control": "no-store",
  });
  res.end(b);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error("Request too large.");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function status() {
  const key = currentKey();
  if (!key) return { ok: false, reason: "no-key" };
  try {
    const m = await pickModel(key);
    let img = null;
    try { img = (await pickImageModel(key))?.id || null; } catch {}
    return { ok: true, model: m, imageModel: img, hint: hint(key), source: keySource() };
  } catch (e) {
    return { ok: false, reason: "model", detail: scrub(e.message), hint: hint(key), source: keySource() };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/status") return json(res, 200, await status());

  // Accept a key typed into the app, prove it works before accepting it, and
  // only then optionally write it to .env.
  if (url.pathname === "/api/key" && req.method === "POST") {
    try {
      const { key, remember } = await readBody(req);
      const k = String(key || "").trim();
      if (!k) return json(res, 400, { ok: false, detail: "Paste a key first." });
      const prev = runtimeKey;
      runtimeKey = k;
      model = modelForKey = catalogue = catalogueForKey = imageModel = imageModelForKey = null;
      try {
        const m = await pickModel(k);
        if (remember) persistKey(k);
        console.log(`   key accepted (${hint(k)})${remember ? ", saved to .env" : ""} · model ${m}`);
        return json(res, 200, { ok: true, model: m, hint: hint(k), source: keySource() });
      } catch (e) {
        runtimeKey = prev;
        model = modelForKey = catalogue = catalogueForKey = imageModel = imageModelForKey = null;
        return json(res, 200, { ok: false, detail: scrub(e.message) });
      }
    } catch (e) {
      return json(res, 400, { ok: false, detail: scrub(e.message) });
    }
  }

  if (url.pathname === "/api/key/forget" && req.method === "POST") {
    runtimeKey = null;
    model = modelForKey = catalogue = catalogueForKey = imageModel = imageModelForKey = null;
    images.clear();
    try {
      if (existsSync(ENV_PATH)) persistKey(null);
    } catch {}
    console.log("   key forgotten");
    return json(res, 200, await status());
  }

  if (url.pathname === "/api/image" && req.method === "POST") {
    const key = currentKey();
    if (!key) return json(res, 400, { error: "No API key set." });
    try {
      const { seed, roomId, scene } = await readBody(req);
      if (!roomId || !scene) return json(res, 400, { error: "Nothing to draw." });
      return json(res, 200, { image: await makeImage(key, seed, roomId, scene) });
    } catch (e) {
      return json(res, 500, { error: scrub(e.message) });
    }
  }

  if (url.pathname === "/api/turn" && req.method === "POST") {
    if (!currentKey()) return json(res, 400, { error: "No API key set. Add one from the header." });
    try {
      return json(res, 200, await takeTurn(await readBody(req)));
    } catch (e) {
      const msg = e.name === "AbortError" ? "The model took too long to answer." : scrub(e.message);
      return json(res, 500, { error: msg });
    }
  }

  // static
  const p = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(PUBLIC, normalize(p).replace(/^([/\\])+/, ""));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
});

// Loopback only — the key can now be set over HTTP, so don't expose this
// to the rest of the network.
server.listen(PORT, "127.0.0.1", () => {
  const bar = "─".repeat(46);
  console.log(`\n  ${bar}`);
  console.log(`   DEAD RECKONING  ·  http://localhost:${PORT}`);
  console.log(`  ${bar}`);
  const key = currentKey();
  if (!key) {
    console.log("\n   No key yet — paste one into the page when it opens.");
    console.log("   Free keys: https://aistudio.google.com/apikey\n");
  } else {
    console.log(`\n   key ${hint(key)} from ${keySource()}`);
    pickModel(key)
      .then((m) => console.log(`   model ${m}\n`))
      .catch((e) => console.log(`   model lookup failed: ${scrub(e.message)}\n`));
  }
});
