// Targets Marinara Engine v2.5.0 (selection "로어북에 추가" button, active chat
// id in localStorage, /api/chats/:id for the title).
const EXTENSION_VERSION = "2.5.4";
const STORAGE_KEY = "marinara-quote-card-settings-v1";
const DOWNLOAD_COUNTER_KEY = "marinara-quote-card-download-counter-v1";
const ACTIVE_CHAT_ID_KEY = "marinara-active-chat-id";
// Marinara 2.5.0's own selection button ("로어북에 추가"). Ours is placed
// beside it instead of on top of it.
const NATIVE_SELECTION_BUTTON_SELECTOR = "[data-selection-lorebook-button]";
const MESSAGE_TEXT_SELECTOR = ".mari-message-content";
// The inline translation block a message can show (toggled by the message's
// 번역 button) renders as a sibling right after .mari-message-content, not
// inside it, so it needs its own clause to be selectable for excerpting.
const MESSAGE_TRANSLATION_SELECTOR =
  ".mari-message-content ~ div.border-t.pt-2, .mari-message-content ~ div.border-t.pt-2 *";
const CHAT_CONTENT_SELECTOR = `${MESSAGE_TEXT_SELECTOR}, ${MESSAGE_TRANSLATION_SELECTOR}`;
const CARD_WIDTH = 1080;
const RATIOS = {
  square: { label: "정사각형 (1:1)", width: 1080, height: 1080 },
  portrait: { label: "세로형 (4:5)", width: 1080, height: 1350 },
  story: { label: "스토리 (9:16)", width: 1080, height: 1920 },
  // height is computed per-render from the text length instead of fixed,
  // so short excerpts don't get padded out with empty top/bottom margin.
  auto: { label: "자동 (내용에 맞춤)", width: 1080, height: null },
};
const AUTO_RATIO_MIN_HEIGHT = 480;
// "자동 (내용에 맞춤)" means "sized to fit the content" — the whole point is
// that nothing gets truncated. This used to cap out at 1920 (== the fixed
// 스토리 ratio's height), which silently dropped the back half of any excerpt
// longer than roughly 18-20 lines with zero indication anything was missing
// ("본문이 길면 밑부분이 잘림"). Raised well past any realistic excerpt length;
// still capped (rather than removed outright) as a safety ceiling against a
// canvas so tall it could fail to allocate on memory-constrained mobile
// browsers if someone selected an entire chapter by mistake.
const AUTO_RATIO_MAX_HEIGHT = 8000;
const FONT_SIZES = [28, 30, 32, 34, 36];
// PNG export resolution multiplier — the on-screen preview canvas always
// stays at the logical (×1) size for performance, but the file actually
// saved is rendered at ratioWidth*scale × ratioHeight*scale (see renderCard's
// ctx.setTransform + the saveButton handler exporting from offscreenCanvas
// instead of the small preview canvas).
const EXPORT_SCALES = [1, 2, 3];
// Only the site's font library is fetched over the network (backgrounds here
// are the fixed BACKGROUND_PRESETS palette, not the gallery API 발췌 카드
// uses) — same allowlist-then-fetch pattern as 발췌 카드's apiJson, kept even
// though there's only one entry so a future addition can't silently skip the
// allowlist check.
// /chats/:id is read only for the active chat's title (2.5.0 no longer
// exposes it in the sidebar markup the old lookup relied on).
const ALLOWED_API_PATHS = [/^\/fonts$/, /^\/chats\/[\w-]+$/];

// Background palette, picked as individually-rounded swatch buttons. "테마"
// has no fixed hex — it's a pastel tint of the site's live theme accent (see
// resolveThemeBackgroundHex), refreshed every time the dialog opens.
const BACKGROUND_PRESETS = [
  { key: "white", hex: "#ffffff", label: "화이트" },
  { key: "cream", hex: "#fdf8f0", label: "크림" },
  { key: "theme", hex: null, label: "테마" },
  { key: "charcoal", hex: "#1e1e1e", label: "차콜" },
  { key: "deepBlue", hex: "#0f1523", label: "딥 블루" },
  { key: "deepGreen", hex: "#0c1a10", label: "딥 그린" },
];

// Card design variations — decoration only; text layout is shared.
const CARD_STYLES = [
  { key: "classic", label: "클래식" },
  { key: "minimal", label: "미니멀" },
  { key: "quote", label: "인용" },
  { key: "frame", label: "액자" },
  { key: "glow", label: "그라데이션" },
  { key: "note", label: "노트" },
  { key: "grid", label: "모눈" },
  { key: "tape", label: "테이프" },
  { key: "ticket", label: "티켓" },
  { key: "film", label: "필름" },
];
const CARD_STYLE_KEYS = new Set(CARD_STYLES.map((style) => style.key));

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!match) return null;
  return { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) };
}

function rgbToHex(r, g, b) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgba(hex, alpha) {
  const rgb = hexToRgb(hex) || { r: 139, g: 92, b: 246 };
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

// Luminance-based "is this a dark card" check (decides text/divider colors).
const darkHexCache = new Map();
function isDarkHex(hex) {
  let dark = darkHexCache.get(hex);
  if (dark === undefined) {
    const rgb = hexToRgb(hex);
    dark = rgb ? relativeLuminance(rgb.r, rgb.g, rgb.b) < 0.2 : false;
    darkHexCache.set(hex, dark);
  }
  return dark;
}

// Blends hexA toward hexB by `ratio` (0 = pure hexA, 1 = pure hexB). Used to
// fade *emphasis* text toward the card's own background color instead of
// picking a fixed lighter/darker shade — blending toward the background
// reads as "lighter/fainter" correctly on both light and dark cards, where a
// fixed HSL-lightness bump could easily go the wrong direction or wash out
// entirely depending on how light the base text color already is.
function mixHexColors(hexA, hexB, ratio) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return hexA;
  return rgbToHex(a.r + (b.r - a.r) * ratio, a.g + (b.g - a.g) * ratio, a.b + (b.b - a.b) * ratio);
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

// Text colors are nudged toward a minimum (on dark backgrounds) or maximum
// (on light backgrounds) lightness only when the picked color doesn't
// already clear that bar — an already-legible color (e.g. the default
// violet dialogue accent, which is plenty light on its own) is left exactly
// as picked instead of always shifting by a fixed amount and washing out.
// 대사/테두리 색상 (dialogue text — the border stroke and top stripe always
// keep the raw picked color untouched): a lower dark-background minimum
// (usually already a saturated, fairly light accent color) and a gentle
// light-background maximum (just "a little darker", not a jarring recolor
// away from the swatch the person actually picked). 글자 색상 (narration text
// + footer title) and the "MARINARA" footer wordmark use a much higher
// dark-background minimum, since their default is a near-black gray that
// needs to become genuinely bright to read on a dark card.
const DIALOGUE_DARK_BG_MIN_LIGHTNESS = 0.5;
const DIALOGUE_LIGHT_BG_MAX_LIGHTNESS = 0.55;
const NARRATION_DARK_BG_MIN_LIGHTNESS = 0.82;
const NARRATION_LIGHT_BG_MAX_LIGHTNESS = 0.42;
function resolveReadableTextColor(
  hex,
  backgroundHex,
  darkBgMinLightness = DIALOGUE_DARK_BG_MIN_LIGHTNESS,
  lightBgMaxLightness = DIALOGUE_LIGHT_BG_MAX_LIGHTNESS,
) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const isDarkBackground = isDarkHex(backgroundHex);
  const adjustedL = isDarkBackground ? Math.max(l, darkBgMinLightness) : Math.min(l, lightBgMaxLightness);
  if (adjustedL === l) return hex;
  const adjustedRgb = hslToRgb(h, s, adjustedL);
  return rgbToHex(adjustedRgb.r, adjustedRgb.g, adjustedRgb.b);
}

// Reused across every resolveThemeColorHex() call instead of creating a new
// <canvas> each time — the probe only needs its fillStyle normalization, not
// a real drawing surface, so one throwaway context is enough for the whole
// session.
const colorProbeCtx = document.createElement("canvas").getContext("2d");

// Resolves a CSS custom property (e.g. Marinara's own theme "--primary") to a
// concrete #rrggbb string usable both as a canvas fillStyle and as an
// <input type="color"> value. Falls back if the variable isn't set, isn't a
// real color, or resolves to something (e.g. an oklch()/rgb() string) that
// doesn't reduce to a plain hex triplet.
function resolveThemeColorHex(varName, fallbackHex) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw || !colorProbeCtx) return fallbackHex;
  try {
    colorProbeCtx.fillStyle = fallbackHex;
    colorProbeCtx.fillStyle = raw;
    const normalized = colorProbeCtx.fillStyle;
    const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(normalized);
    if (rgbMatch) {
      const toHex = (n) => Number(n).toString(16).padStart(2, "0");
      return `#${toHex(rgbMatch[1])}${toHex(rgbMatch[2])}${toHex(rgbMatch[3])}`;
    }
    return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : fallbackHex;
  } catch {
    return fallbackHex;
  }
}

// Falls back to violet when the site's theme accent (--primary) can't be
// read at all.
const FALLBACK_ACCENT_HEX = "#8b5cf6";

// A soft, light pastel tint of the site's current theme accent, used for the
// "테마" background preset — e.g. a pink theme yields a warm light pink.
function resolveThemeBackgroundHex(accentHex) {
  const rgb = hexToRgb(accentHex);
  if (!rgb) return "#f3f0ff";
  const { h, s } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const pastelSaturation = Math.min(0.5, Math.max(0.16, s * 0.5));
  const pastelRgb = hslToRgb(h, pastelSaturation, 0.94);
  return rgbToHex(pastelRgb.r, pastelRgb.g, pastelRgb.b);
}

// The card's point color (대사/테두리 색상) defaults to Marinara's own theme
// accent instead of a hardcoded violet, so a first-time card already matches
// whatever theme the person is using. It's always a free color picker from
// there — this only decides the starting value; openModal() re-resolves the
// live theme color every time it opens (see dialogueColorMode below), so
// switching the site's theme is picked up without needing a page reload.
const DEFAULT_DIALOGUE_COLOR = resolveThemeColorHex("--primary", FALLBACK_ACCENT_HEX);

const DEFAULTS = {
  ratio: "portrait",
  // Empty string means "기본 (Inter)" — the site's font library (fetched from
  // /api/fonts, same source and dropdown pattern as 발췌 카드) is opt-in per
  // card rather than a forced default.
  font: "",
  fontSizeLevel: 3,
  // PNG export resolution multiplier (1×/2×/3×) — see EXPORT_SCALES. Doesn't
  // affect the on-screen preview, only the saved file's pixel dimensions.
  exportScale: 1,
  alignment: "left",
  backgroundColor: "#ffffff",
  backgroundPresetKey: "white",
  textColor: "#262626",
  dialogueColor: DEFAULT_DIALOGUE_COLOR,
  // "theme" means 대사/테두리 색상 keeps following the site's live theme accent
  // on every modal open; "custom" means the person picked their own color and
  // it should stick instead of being overwritten by theme changes.
  dialogueColorMode: "theme",
  footerLabel: "title",
  // Only used when footerLabel === "custom" — the person's own typed text
  // for the footer line, in place of the character/chat title or the
  // "MARINARA" wordmark.
  footerLabelCustomText: "",
  regexRules: [],
  // Only relevant when a pasted chat log is auto-detected (see
  // detectChatLog): "transcript" is the clean 이름+대사 list, "bubble" is a
  // messenger-style layout with left/right message bubbles.
  chatLayoutStyle: "transcript",
  // "auto" alternates left/right by first-appearance order (1st speaker
  // left, 2nd right, 3rd left, ...); "custom" means the person has manually
  // assigned specific speakers to the right side via the 말풍선 방향 pills.
  chatSideMode: "auto",
  chatRightSpeakers: [],
  cardStyle: "classic",
  // Last-open dialog tab (see DIALOG_TABS).
  dialogTab: "text",
};

let selectedText = "";
// The live selection's range, captured when the button is shown.
let selectedRange = null;
let selectedChatTitle = "캐릭터";
let renderSequence = 0;
let selectionTimer = 0;
let openingFromPointer = false;
// Tracks whether the person has manually toggled any 말풍선 방향 pill for the
// currently open modal session — mirrors dialogueColorIsCustom's pattern.
let chatSideIsCustom = false;
let chatRightSpeakersCustom = [];
// Speaker key ("A|B|C") the 말풍선 방향 pills were last built
// for, so they're only rebuilt when the detected speaker set actually
// changes (avoids flicker/losing hover state on every keystroke).
let lastChatSpeakersKey = null;
// Fetched once per modal open (see loadFonts/openModal), not per keystroke —
// mirrors 발췌 카드's `fonts` list.
let fonts = [];
// Aborts any in-flight /api/fonts request on cleanup, so a request from a
// closed/torn-down session can't resolve into stale UI later.
const fontRequestController = new AbortController();
const pendingDownloadUrls = new Set();
// Reused across renderCard() calls instead of creating a fresh offscreen
// canvas every time — resizing a canvas clears it anyway, so nothing needs
// to be reset explicitly between renders.
const offscreenCanvas = document.createElement("canvas");
const offscreenCtx = offscreenCanvas.getContext("2d");
// See renderCard: wrapped rows reused while text/font/layout mode are the
// same, and the key of what the preview currently shows.
let layoutCache = { key: "", rows: [] };
let lastPreviewKey = "";
// Tracks which "family:size" combinations we've already confirmed are
// loaded, so repeat renders at the same font+size skip the async
// document.fonts.load round-trip (which is otherwise awaited on every
// single render/keystroke).
const loadedFontSizes = new Set();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// --- Host-runtime compatibility shim ---------------------------------------
// The Marinara personal-extension runtime currently injects a `marinara`
// object with only { version, extension, log, storage, setTimeout/
// clearTimeout/setInterval/clearInterval, onCleanup } — it does not provide
// the `addElement`/`on` DOM helpers this extension was originally written
// against. Calling marinaraCompat.addElement() threw "marinara.addElement is not
// a function" at the very top of this script, which aborted the whole file
// before any of the UI or event listeners below it could be set up.
//
// Rather than mutate the host's `marinara` object (it may be frozen, and
// even if not, patching someone else's object in place is fragile), this
// defines a local `marinaraCompat` that forwards the parts the host DOES
// support and adds the two missing DOM helpers with plain DOM APIs. Every
// `marinaraCompat.addElement(...)` / `marinaraCompat.on(...)` call site below has been
// switched to `marinaraCompat.addElement(...)` / `marinaraCompat.on(...)`;
// `marinara.setTimeout(...)` and `marinara.onCleanup(...)` are left calling
// the real host object since those two are still supported.
// Every node/listener registered here is torn down in marinara.onCleanup, so
// toggling or reloading the extension doesn't leave a second selection
// button and a second set of document listeners behind.
const cleanupTasks = [];
const marinaraCompat = {
  addElement(parent, tag, attrs) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === "class") node.className = value;
      else if (key === "textContent") node.textContent = value;
      else node.setAttribute(key, value);
    });
    if (parent) parent.appendChild(node);
    cleanupTasks.push(() => node.remove());
    return node;
  },
  on(target, eventName, handler, options) {
    target.addEventListener(eventName, handler, options);
    const off = () => target.removeEventListener(eventName, handler, options);
    cleanupTasks.push(off);
    return off;
  },
};

function loadSettings() {
  if (pendingSettings) return { ...DEFAULTS, ...pendingSettings };
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

// Settings used to be written to localStorage synchronously on every render
// (every keystroke). Writes are now coalesced and flushed on close/cleanup.
let pendingSettings = null;
let saveSettingsTimer = 0;
function flushSettings() {
  window.clearTimeout(saveSettingsTimer);
  if (!pendingSettings) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingSettings));
  } catch {
    // Storage full or blocked — settings just won't persist this time.
  }
  pendingSettings = null;
}

function saveSettings(settings) {
  pendingSettings = settings;
  window.clearTimeout(saveSettingsTimer);
  saveSettingsTimer = window.setTimeout(flushSettings, 600);
}

// Saved PNG filenames are "marinara-1.png", "marinara-2.png", ... instead of
// a timestamp — a simple running counter persisted in this browser.
function nextDownloadNumber() {
  const current = Number(localStorage.getItem(DOWNLOAD_COUNTER_KEY)) || 0;
  const next = current + 1;
  localStorage.setItem(DOWNLOAD_COUNTER_KEY, String(next));
  return next;
}

function selectionIsInChat(selection) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const start =
    range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  const end = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
  // Only one end of the drag needs to land inside actual message content.
  // A drag that starts on the speaker-name/header element just above a
  // message (which isn't itself wrapped in CHAT_CONTENT_SELECTOR) still
  // ends inside real message text, and should still offer the excerpt
  // button — requiring BOTH ends silently hid the button for exactly that
  // "drag started from the name" case.
  return Boolean(start?.closest?.(CHAT_CONTENT_SELECTOR) || end?.closest?.(CHAT_CONTENT_SELECTOR));
}

// --- Selection text extraction (preserves *emphasis* the source already
// rendered as real italic HTML) --------------------------------------------
// Marinara's 번역 (translate) view runs *word* markdown through its own
// renderer and turns it into an actual italic element (an <em>/<i> tag, or
// a span with a Tailwind `italic` utility class) — the literal asterisks
// never make it into the DOM's text content at all. A plain
// `selection.toString()` therefore silently drops that emphasis: the
// excerpted text has no "*" characters left for styledCharacters() to find,
// so the card renders that whole line as ordinary narration even though the
// source clearly marks it as emphasis. This walks the selected Range's text
// nodes directly and re-inserts "*...*" markers around any text whose
// nearest styled ancestor renders italic, so the existing
// asterisk-driven emphasis pipeline (color fade + italic, see
// styledCharacters/setTextFont) picks it up exactly as if the person had
// typed the asterisks themselves. Ordinary messages that use the literal
// "*action*" RP convention are untouched by this — their asterisks are
// already plain text characters and pass through unchanged.
const BLOCK_DISPLAY_RE = /^(block|flex|grid|list-item|table)/;

// Classifies ONE ancestor element as block-level and/or italic-rendered.
// Both used to be separate functions (isBlockElement/isItalicElement), each
// doing its own getComputedStyle(node) call — for an element that needed
// both answers (the common case while walking up toward the block AND
// italic ancestor for the same text node) that was two style reads where one
// suffices, since display and fontStyle come off the same CSSStyleDeclaration.
// `cache` is a Map scoped to a single extractSelectionText() call: sibling
// text nodes under the same paragraph/message share most of their ancestor
// chain, so without caching, a multi-line drag-selection re-classifies the
// same wrapper elements over and over, once per text node under them.
function classifyAncestor(node, cache) {
  const cached = cache.get(node);
  if (cached) return cached;
  let isBlock = node.tagName === "BR";
  let isItalic = node.tagName === "EM" || node.tagName === "I";
  if (!isBlock || !isItalic) {
    try {
      const style = getComputedStyle(node);
      if (!isBlock) isBlock = BLOCK_DISPLAY_RE.test(style.display);
      if (!isItalic) isItalic = style.fontStyle === "italic";
    } catch {
      // Leave whatever the cheap tag-name checks above already determined.
    }
  }
  const result = { isBlock, isItalic };
  cache.set(node, result);
  return result;
}

// Walks upward from `node` to `boundary` ONCE, returning both the nearest
// block-level ancestor and the nearest italic-rendered ancestor — replacing
// two independent walks (one per predicate) that used to retrace the exact
// same ancestor chain.
function nearestAncestorInfo(node, boundary, cache) {
  let current = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  let block = null;
  let italic = null;
  while (current && current !== boundary) {
    const info = classifyAncestor(current, cache);
    if (block === null && info.isBlock) block = current;
    if (italic === null && info.isItalic) italic = current;
    if (block !== null && italic !== null) break;
    current = current.parentElement;
  }
  return { block, italic };
}

// Text inside display:none elements (TTS cues like "[grunts]", the hidden
// duplicate message body) isn't part of what's on screen, so it's skipped —
// selection.toString() skips it too.
function isRenderedText(node, cache) {
  const parent = node.parentElement;
  if (!parent) return false;
  let visible = cache?.get(parent);
  if (visible === undefined) {
    visible =
      typeof parent.checkVisibility === "function" ? parent.checkVisibility() : parent.getClientRects().length > 0;
    cache?.set(parent, visible);
  }
  return visible;
}

// Controls other extensions put inline in message text — e.g. the TTS
// "＋ ▷ □" buttons (.mari-tts-line-controls) — are not part of the excerpt.
// Their whole subtree is skipped here, and CSS makes them unselectable.
const NON_TEXT_SELECTOR = "button, .mari-tts-line-controls, textarea, input, script, style";

// Walks the range in document order, clipping the first/last text node to
// the range's actual start/endOffset. Line breaks come from two places:
// <br> elements (Marinara 2.5.0 separates paragraphs with <br>, not "\n"
// characters — reading only text nodes glued paragraphs together) and a
// change of the nearest block-level ancestor (between paragraphs/messages).
// Runs of italic-rendered text are wrapped in "*...*".
function extractSelectionText(range) {
  const boundary =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (!boundary) return "";
  // Sibling text nodes share a parent, so visibility is checked per parent.
  const visibilityCache = new Map();
  const walker = document.createTreeWalker(boundary, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === "BR") return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        // REJECT skips the element's whole subtree; SKIP just descends.
        return node.matches(NON_TEXT_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      return range.intersectsNode(node) && isRenderedText(node, visibilityCache)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  // See classifyAncestor's comment — scoped to this one extraction so shared
  // ancestors across the selection's text nodes are classified only once.
  const ancestorCache = new Map();
  let result = "";
  let lastBlock;
  let hasLastBlock = false;
  let italicOpen = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // <br>: a line break (two in a row make the blank line between
      // paragraphs). Emphasis is closed first so "*" never spans lines.
      if (!hasLastBlock || !isRenderedText(node, visibilityCache)) continue;
      if (italicOpen) {
        result += "*";
        italicOpen = false;
      }
      result += "\n";
      continue;
    }
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.textContent.length;
    if (end <= start) continue;
    const text = node.textContent.slice(start, end);
    if (!text) continue;

    const ancestors = nearestAncestorInfo(node, boundary, ancestorCache);
    const block = ancestors.block || boundary;
    if (hasLastBlock && block !== lastBlock) {
      if (italicOpen) {
        result += "*";
        italicOpen = false;
      }
      // A <br> right before a block change already ended the line.
      if (!result.endsWith("\n")) result += "\n";
    }
    lastBlock = block;
    hasLastBlock = true;

    const italic = Boolean(ancestors.italic);
    if (italic !== italicOpen) {
      result += "*";
      italicOpen = italic;
    }
    result += text;
  }
  if (italicOpen) result += "*";
  return result;
}

// A single button that follows the text selection. Positioned next to
// Marinara 2.5.0's own "로어북에 추가" button instead of on top of it (see
// positionSelectionButton).
const selectionButton = marinaraCompat.addElement(document.body, "button", {
  class: "mqc-selection-button",
  type: "button",
  textContent: "✦ 발췌 이미지",
  "aria-label": "선택한 글을 이미지로 만들기",
});

const overlay = marinaraCompat.addElement(document.body, "div", {
  class: "mqc-overlay",
  role: "dialog",
  "aria-modal": "true",
  "aria-label": "발췌 이미지 만들기",
});

const dialog = el("div", "mqc-dialog");
const previewPane = el("div", "mqc-preview-pane");
const canvas = el("canvas", "mqc-preview");
canvas.width = CARD_WIDTH;
canvas.height = RATIOS.portrait.height;
const previewCtx = canvas.getContext("2d");
previewPane.append(canvas);

const controls = el("div", "mqc-controls");
const header = el("div", "mqc-header");
const titleNode = el("h2", "mqc-title", "발췌 이미지 만들기");
titleNode.append(el("span", "mqc-version", `v${EXTENSION_VERSION}`));
header.append(titleNode);
const closeButton = el("button", "mqc-close", "×");
closeButton.type = "button";
closeButton.setAttribute("aria-label", "닫기");
header.append(closeButton);

const form = el("div", "mqc-form");
const textField = makeField("발췌문");
const textArea = el("textarea", "mqc-textarea");
textArea.maxLength = 5000;
textField.append(textArea);

const ratioField = makeField("이미지 비율");
const ratioSegments = el("div", "mqc-segments");
[
  ["square", "1:1", "mqc-ratio-square"],
  ["portrait", "4:5", "mqc-ratio-portrait"],
  ["story", "9:16", "mqc-ratio-story"],
  ["auto", "자동 (내용에 맞춤)", "mqc-ratio-auto"],
].forEach(([value, label, iconClass]) => {
  const button = makeSegment(value, label);
  const icon = el("span", `mqc-ratio-icon ${iconClass}`);
  button.replaceChildren(icon);
  ratioSegments.append(button);
});
ratioField.append(ratioSegments);

const alignmentField = makeField("본문 정렬");
const alignmentSegments = el("div", "mqc-segments");
[
  ["left", "좌측 정렬"],
  ["center", "중앙 정렬"],
  ["justify", "양방향 정렬"],
  ["right", "우측 정렬"],
].forEach(([value, label]) => {
  const button = makeSegment(value, label);
  const icon = el("span", `mqc-align-icon mqc-align-icon-${value}`);
  icon.append(el("i"), el("i"), el("i"), el("i"));
  button.replaceChildren(icon);
  alignmentSegments.append(button);
});
alignmentField.append(alignmentSegments);

// Populated from /api/fonts on modal open (see loadFonts/populateFonts) —
// same site-wide font library 발췌 카드 uses. Empty value ("기본 (Inter)")
// keeps the previous hardcoded-Inter behavior as the default.
const fontField = makeField("폰트");
const fontSelect = el("select", "mqc-select");
fontField.append(fontSelect);

// Export resolution — only changes the saved PNG's pixel dimensions (see
// EXPORT_SCALES/renderCard), not the on-screen preview.
const exportScaleField = makeField("저장 배율");
const exportScaleSegments = el("div", "mqc-segments");
EXPORT_SCALES.forEach((scale) => {
  const button = makeSegment(String(scale), `${scale}배 해상도로 저장`, `${scale}×`);
  exportScaleSegments.append(button);
});
exportScaleField.append(exportScaleSegments);

const alignmentFontPair = el("div", "mqc-compact-pair");
alignmentFontPair.append(alignmentField, fontField);

const sizeField = makeField("글자 크기");
const sizeSegments = el("div", "mqc-segments");
const sizeMinusButton = makeSegment("minus", "글자 크기 줄이기", "−");
const sizeLevelDisplay = el("span", "mqc-segment", "3");
sizeLevelDisplay.dataset.sizeDisplay = "true";
const sizePlusButton = makeSegment("plus", "글자 크기 늘리기", "+");
sizeSegments.append(sizeMinusButton, sizeLevelDisplay, sizePlusButton);
sizeField.append(sizeSegments);

const textColorField = makeColorField("글자 색상", "#262626");
const dialogueColorField = makeColorField("대사/테두리 색상", DEFAULT_DIALOGUE_COLOR);
// Tracks whether the person has manually edited 대사/테두리 색상 away from
// following the site theme, for the currently open modal session — flipped
// to true by the color input's own "input" handler below.
let dialogueColorIsCustom = false;

// 글자 크기·글자 색상·대사/테두리 색상을 한 줄에 모아 붙여둔다 (스포이드 두 개가
// 서로 붙어 있도록).
const styleRow = el("div", "mqc-style-row");
styleRow.append(sizeField, textColorField.field, dialogueColorField.field);

// Footer label shows the chat/character title, the plain "MARINARA"
// wordmark, or a person-typed custom string — never more than one at a
// time — switchable with this segment trio. The third choice ("직접입력")
// is not a plain button that reveals a text field elsewhere — the segment
// ITSELF is the text input, so picking it and typing the footer text is one
// motion instead of two.
const footerLabelField = makeField("하단 라벨");
const footerLabelSegments = el("div", "mqc-segments");
[
  ["title", "캐릭터 이름"],
  ["marinara", "MARINARA"],
].forEach(([value, label]) => {
  const button = makeSegment(value, label, label);
  footerLabelSegments.append(button);
});
const footerCustomLabelInput = el("input", "mqc-segment mqc-segment-input");
footerCustomLabelInput.type = "text";
footerCustomLabelInput.maxLength = 60;
footerCustomLabelInput.dataset.value = "custom";
footerCustomLabelInput.placeholder = "직접입력";
footerCustomLabelInput.title = "직접입력 (클릭해서 텍스트 입력)";
footerCustomLabelInput.setAttribute("aria-label", "하단 라벨 직접 입력");
// Set inline as well as in the stylesheet (belt and suspenders — the host
// page's own global input styling, injected into the same document rather
// than an isolated shadow root, can carry an equal-or-higher specificity
// rule that wins depending on load order). The actual root cause of the
// placeholder not centering, confirmed by testing isolated variants
// side by side directly on the real page: .mqc-segment's
// `display: grid; place-items: center` — inherited via the shared
// .mqc-segment class — breaks placeholder centering specifically on
// <input> in Chrome, even though computed style still reports
// text-align: center. Overriding display back to "block" and centering
// manually (text-align horizontal, line-height matched to the fixed height
// for vertical) sidesteps whatever that grid/placeholder interaction is.
footerCustomLabelInput.style.display = "block";
footerCustomLabelInput.style.lineHeight = "1.8rem";
footerCustomLabelInput.style.width = "100%";
footerCustomLabelInput.style.boxSizing = "border-box";
footerCustomLabelInput.style.textAlign = "center";
footerLabelSegments.append(footerCustomLabelInput);
footerLabelField.append(footerLabelSegments);

// Only shown when the current 발췌문 is auto-detected as a pasted chat log
// (see detectChatLog) — lets the person pick between the plain transcript
// layout and a messenger-style bubble layout, and (for bubbles) which
// speaker(s) render on the right side. Both start hidden; updateChatControls
// toggles their visibility on every render.
const chatStyleField = makeField("채팅 로그 스타일");
const chatStyleSegments = el("div", "mqc-segments");
[
  ["transcript", "대화록"],
  ["bubble", "말풍선"],
].forEach(([value, label]) => {
  const button = makeSegment(value, label, label);
  chatStyleSegments.append(button);
});
chatStyleField.append(chatStyleSegments);
chatStyleField.style.display = "none";

// Short label — the fuller "오른쪽으로 표시할 화자" explanation lives in each
// pill's title tooltip instead, so this fits comfortably next to
// 채팅 로그 스타일 in a half-width compact-pair column instead of stretching
// a handful of small pills across the whole dialog width.
const chatSideField = makeField("말풍선 방향");
const chatSidePills = el("div", "mqc-chat-side-pills");
chatSideField.append(chatSidePills);
chatSideField.style.display = "none";

const chatControlsPair = el("div", "mqc-compact-pair");
chatControlsPair.append(chatStyleField, chatSideField);

// Background: preset swatches (see BACKGROUND_PRESETS), activated by their
// stable key — the "테마" swatch's hex changes with the site theme.
const backgroundField = makeField("배경");
const backgroundPresetGrid = el("div", "mqc-preset-grid");
const themeBackgroundButton = (() => {
  let themeButton = null;
  BACKGROUND_PRESETS.forEach(({ key, hex, label }) => {
    const initialHex = hex || "#f3f0ff";
    const button = makeSegment(initialHex, label, label);
    button.classList.add("mqc-preset");
    button.dataset.presetKey = key;
    button.style.backgroundColor = initialHex;
    button.style.color = isDarkHex(initialHex) ? "#f5f5f5" : "#3a3a3a";
    backgroundPresetGrid.append(button);
    if (!hex) themeButton = button;
  });
  return themeButton;
})();
backgroundField.append(backgroundPresetGrid);

function refreshThemeBackgroundPreset(accentHex) {
  const hex = resolveThemeBackgroundHex(accentHex);
  themeBackgroundButton.dataset.value = hex;
  themeBackgroundButton.style.backgroundColor = hex;
}

function setActiveBackgroundPreset(key) {
  backgroundPresetGrid.querySelectorAll(".mqc-preset").forEach((button) => {
    button.dataset.active = String(button.dataset.presetKey === key);
  });
}

const cardStyleField = makeField("카드 디자인");
const cardStyleGrid = el("div", "mqc-style-grid");
CARD_STYLES.forEach(({ key, label }) => {
  const button = makeSegment(key, `${label} 디자인`, "");
  button.classList.add("mqc-card-style");
  const thumb = el("span", `mqc-card-thumb mqc-card-thumb-${key}`);
  thumb.append(el("i"), el("i"));
  button.append(thumb, el("span", "mqc-card-style-label", label));
  cardStyleGrid.append(button);
});
cardStyleField.append(cardStyleGrid);

const regexBox = el("div", "mqc-regex-box");
const regexHeader = el("div", "mqc-regex-header");
regexHeader.append(el("span", "mqc-label", "정규식"));

// Quick-insert buttons for symbols that are awkward to type directly (no
// dedicated key, IME-unfriendly, etc.) — clicking one inserts it at the
// cursor position of whichever 치환 input was last focused (or the first
// rule's 치환 input if none has focus yet). These symbols are meant to land
// in the substituted-in text, not the search pattern, so only 치환 inputs
// are tracked/targeted. "＋ 추가" comes last in this row, after the symbols.
const REGEX_QUICK_SYMBOLS = ["☆", "★", "♡", "♥", "■"];
const regexSymbolRow = el("div", "mqc-regex-symbols");
REGEX_QUICK_SYMBOLS.forEach((symbol) => {
  const symbolButton = el("button", "mqc-regex-symbol", symbol);
  symbolButton.type = "button";
  symbolButton.title = `"${symbol}" 입력`;
  symbolButton.setAttribute("aria-label", `${symbol} 기호 입력`);
  symbolButton.addEventListener("click", () => insertRegexSymbol(symbol));
  regexSymbolRow.append(symbolButton);
});
const regexAddButton = el("button", "mqc-regex-add", "＋ 추가");
regexAddButton.type = "button";
regexSymbolRow.append(regexAddButton);

// The symbol row lives inside regexHeader itself (not appended as a separate
// sibling row below it), so "정규식" and "＋ 추가"+기호 stay on one line —
// regexHeader is a single flex row with the label and this group pushed to
// opposite ends, rather than the label stacking above a second row.
regexHeader.append(regexSymbolRow);

const regexList = el("div", "mqc-regex-list");
regexBox.append(regexHeader, regexList);

// Tracks whichever 치환 input the person last focused, so a symbol button
// knows where to insert. Attached to the persistent regexList container
// (event delegation) rather than per-input, since rows get replaced
// wholesale on modal open.
let lastFocusedRegexInput = null;
regexList.addEventListener("focusin", (event) => {
  const input = event.target.closest("input[data-regex-replacement]");
  if (input) lastFocusedRegexInput = input;
});

function insertRegexSymbol(symbol) {
  let target = lastFocusedRegexInput && regexList.contains(lastFocusedRegexInput) ? lastFocusedRegexInput : null;
  if (!target) {
    if (!regexList.querySelector(".mqc-regex-grid")) addRegexRule();
    target = regexList.querySelector("[data-regex-replacement]");
  }
  if (!target) return;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  target.value = target.value.slice(0, start) + symbol + target.value.slice(end);
  const cursor = start + symbol.length;
  target.focus();
  target.setSelectionRange(cursor, cursor);
  lastFocusedRegexInput = target;
  // Re-render directly instead of dispatching a synthetic "input" event —
  // the goal is just "the regex text changed, recompute", and constructing
  // a same-realm Event here is unnecessarily fragile across embedding
  // contexts.
  queueRender();
}

// Controls are split into tabs so each screen stays short: 본문 (the text
// and how it reads), 디자인 (how the card looks), 고급 (export + regex).
const DIALOG_TABS = [
  { key: "text", label: "본문" },
  { key: "design", label: "디자인" },
  { key: "advanced", label: "고급" },
];
const tabBar = el("div", "mqc-tabs");
tabBar.setAttribute("role", "tablist");
const tabPanels = new Map();
DIALOG_TABS.forEach(({ key, label }) => {
  const tab = el("button", "mqc-tab", label);
  tab.type = "button";
  tab.dataset.tab = key;
  tab.setAttribute("role", "tab");
  tabBar.append(tab);
  const panel = el("div", "mqc-tab-panel");
  panel.setAttribute("role", "tabpanel");
  tabPanels.set(key, panel);
  form.append(panel);
});
const ratioFooterPair = el("div", "mqc-compact-pair");
ratioFooterPair.append(ratioField, footerLabelField);
tabPanels.get("text").append(textField, alignmentFontPair, styleRow, chatControlsPair);
tabPanels.get("design").append(cardStyleField, backgroundField, ratioFooterPair);
tabPanels.get("advanced").append(exportScaleField, regexBox);

let activeTab = "text";
function showTab(key) {
  activeTab = tabPanels.has(key) ? key : "text";
  tabBar.querySelectorAll(".mqc-tab").forEach((tab) => {
    const selected = tab.dataset.tab === activeTab;
    tab.dataset.active = String(selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  tabPanels.forEach((panel, key) => {
    panel.hidden = key !== activeTab;
  });
  form.scrollTop = 0;
}

const status = el("div", "mqc-status", "");

const actions = el("div", "mqc-actions");
const cancelButton = el("button", "mqc-action", "취소");
cancelButton.type = "button";
const saveButton = el("button", "mqc-action mqc-action-primary", "PNG 저장");
saveButton.type = "button";
actions.append(cancelButton, saveButton);
controls.append(header, tabBar, form, status, actions);
dialog.append(previewPane, controls);
overlay.append(dialog);

function makeField(label) {
  const field = el("div", "mqc-field");
  field.append(el("span", "mqc-label", label));
  return field;
}

function makeSegment(value, label, text) {
  const button = el("button", "mqc-segment", text);
  button.type = "button";
  button.dataset.value = value;
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

function activeSegmentValue(container, fallback) {
  return container.querySelector('[data-active="true"]')?.dataset.value || fallback;
}

// Like activeSegmentValue, but reads data-presetKey — used for the
// background preset grid so a stable identity ("theme") survives even though
// the theme preset's own hex value can change between sessions.
function activeSegmentKey(container, fallback) {
  return container.querySelector('[data-active="true"]')?.dataset.presetKey || fallback;
}

function setActiveSegment(container, value) {
  container.querySelectorAll(".mqc-segment[data-value]").forEach((button) => {
    button.dataset.active = String(button.dataset.value === value);
  });
}

function addRegexRule(pattern = "", replacement = "") {
  const row = el("div", "mqc-regex-grid");
  const patternInput = el("input", "mqc-input");
  patternInput.placeholder = "원본";
  patternInput.value = pattern;
  patternInput.dataset.regexPattern = "true";
  const arrow = el("span", "mqc-regex-arrow", "→");
  const replacementInput = el("input", "mqc-input");
  replacementInput.placeholder = "치환";
  replacementInput.value = replacement;
  replacementInput.dataset.regexReplacement = "true";
  const removeButton = el("button", "mqc-regex-remove", "×");
  removeButton.type = "button";
  removeButton.title = "규칙 삭제";
  removeButton.setAttribute("aria-label", "정규식 규칙 삭제");
  row.append(patternInput, arrow, replacementInput, removeButton);
  regexList.append(row);
  [patternInput, replacementInput].forEach((input) => input.addEventListener("input", queueTypingRender));
  removeButton.addEventListener("click", () => {
    row.remove();
    queueRender();
  });
}

function readRegexRules() {
  return Array.from(regexList.querySelectorAll(".mqc-regex-grid"))
    .map((row) => ({
      pattern: row.querySelector("[data-regex-pattern]")?.value || "",
      replacement: row.querySelector("[data-regex-replacement]")?.value || "",
    }))
    .filter((rule) => rule.pattern);
}

function makeColorField(label, value) {
  const field = makeField(label);
  const row = el("div", "mqc-color-row");
  const input = el("input", "mqc-color");
  input.type = "color";
  input.value = value;
  const display = el("span", "mqc-color-value", value.toUpperCase());
  row.append(input, display);
  field.append(row);
  return { field, input, display };
}

// Sets a makeColorField()'s <input type="color"> value and keeps its hex
// display span in sync in one call, instead of repeating the same two lines
// at every call site (openModal() restoring saved settings, each color
// input's own "input" listener echoing back what the person just picked).
function setColorFieldValue(field, hex) {
  field.input.value = hex;
  field.display.textContent = hex.toUpperCase();
}

function syncColorFieldDisplay(field) {
  field.display.textContent = field.input.value.toUpperCase();
}

// Same allowlist-checked GET-JSON helper as 발췌 카드's apiJson, trimmed to
// only the one path this extension actually calls.
async function apiJson(path) {
  if (!ALLOWED_API_PATHS.some((pattern) => pattern.test(path))) {
    throw new Error("허용되지 않은 마리나라 API 경로입니다.");
  }
  const response = await fetch(`/api${path}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: fontRequestController.signal,
  });
  if (!response.ok) {
    throw new Error(`마리나라 API 요청 실패 (${response.status})`);
  }
  return response.json();
}

// The font library rarely changes, so it's fetched at most once every few
// minutes instead of on every single dialog open.
const FONT_CACHE_MS = 5 * 60_000;
let fontsLoadedAt = 0;
// A failed request isn't retried on every open either.
const FONT_RETRY_MS = 60_000;
let fontsFailedAt = 0;
// Resolves true when a new list arrived (the dropdown needs rebuilding).
async function loadFonts() {
  if (fontsLoadedAt && Date.now() - fontsLoadedAt < FONT_CACHE_MS) return false;
  if (fontsFailedAt && Date.now() - fontsFailedAt < FONT_RETRY_MS) return false;
  try {
    const result = await apiJson("/fonts");
    fonts = Array.isArray(result) ? result : [];
    fontsLoadedAt = Date.now();
    return true;
  } catch {
    // Offline, blocked, or empty library — dropdown just falls back to the
    // single "기본 (Inter)" option below.
    fontsFailedAt = Date.now();
    return false;
  }
}

// Rebuilt only when the font list itself changed; otherwise just reselects.
let populatedFonts = null;
function populateFonts(selected) {
  if (populatedFonts === fonts && fontSelect.querySelector(`option[value="${CSS.escape(selected)}"]`)) {
    fontSelect.value = selected;
    return;
  }
  populatedFonts = fonts;
  fontSelect.replaceChildren();
  const defaultOption = el("option", "", "기본 (Inter)");
  defaultOption.value = "";
  fontSelect.append(defaultOption);
  const seen = new Set();
  fonts.forEach((font) => {
    const family = String(font?.family || "").trim();
    if (!family || seen.has(family)) return;
    seen.add(family);
    const option = el("option", "", family);
    option.value = family;
    fontSelect.append(option);
  });
  // Until the library has loaded once, keep the saved font as its own option
  // instead of silently falling back to the default.
  if (selected && !seen.has(selected) && !fontsLoadedAt) {
    const pending = el("option", "", selected);
    pending.value = selected;
    fontSelect.append(pending);
    seen.add(selected);
  }
  fontSelect.value = seen.has(selected) ? selected : "";
}

function settingsFromControls() {
  const fontSizeLevel = Math.min(5, Math.max(1, Number(sizeLevelDisplay.textContent) || 3));
  return {
    ratio: activeSegmentValue(ratioSegments, "portrait"),
    font: fontSelect.value,
    exportScale: Number(activeSegmentValue(exportScaleSegments, "1")) || 1,
    fontSizeLevel,
    alignment: activeSegmentValue(alignmentSegments, "left"),
    backgroundColor: activeSegmentValue(backgroundPresetGrid, DEFAULTS.backgroundColor),
    backgroundPresetKey: activeSegmentKey(backgroundPresetGrid, "white"),
    textColor: textColorField.input.value,
    dialogueColor: dialogueColorField.input.value,
    dialogueColorMode: dialogueColorIsCustom ? "custom" : "theme",
    footerLabel: activeSegmentValue(footerLabelSegments, "title"),
    footerLabelCustomText: footerCustomLabelInput.value,
    regexRules: readRegexRules(),
    chatLayoutStyle: activeSegmentValue(chatStyleSegments, "transcript"),
    chatSideMode: chatSideIsCustom ? "custom" : "auto",
    chatRightSpeakers: [...chatRightSpeakersCustom],
    cardStyle: activeSegmentValue(cardStyleGrid, DEFAULTS.cardStyle),
    dialogTab: activeTab,
  };
}

// Default left/right split when the person hasn't customized it: alternate
// by first-appearance order (1st speaker left, 2nd right, 3rd left, ...) —
// a reasonable guess for the common 2-person chat log case.
function defaultRightSpeakers(speakerNames) {
  return speakerNames.filter((_, index) => index % 2 === 1);
}

function resolveRightSpeakerSet(speakerNames, settings) {
  if (settings.chatSideMode === "custom") {
    return new Set((settings.chatRightSpeakers || []).filter((name) => speakerNames.includes(name)));
  }
  return new Set(defaultRightSpeakers(speakerNames));
}

function uniqueSpeakerNames(chatBlocks) {
  const seen = new Set();
  const names = [];
  for (const block of chatBlocks) {
    if (!seen.has(block.speaker)) {
      seen.add(block.speaker);
      names.push(block.speaker);
    }
  }
  return names;
}

// Shows/hides the 채팅 로그 스타일 + 말풍선 방향 controls depending on whether
// the current 발췌문 is auto-detected as a chat log, and rebuilds the 말풍선
// 방향 pill buttons only when the detected speaker set actually changes (so
// typing within the same conversation doesn't reset hover/focus state).
function updateChatControls(chatBlocks, currentSettings) {
  if (!chatBlocks) {
    chatStyleField.style.display = "none";
    chatSideField.style.display = "none";
    lastChatSpeakersKey = null;
    return;
  }
  chatStyleField.style.display = "";
  const speakerNames = uniqueSpeakerNames(chatBlocks);
  const showSidePicker = currentSettings.chatLayoutStyle === "bubble" && speakerNames.length > 1;
  chatSideField.style.display = showSidePicker ? "" : "none";
  if (!showSidePicker) {
    lastChatSpeakersKey = null;
    return;
  }

  const key = speakerNames.join(" ");
  if (key === lastChatSpeakersKey) return;
  lastChatSpeakersKey = key;

  const rightSet = resolveRightSpeakerSet(speakerNames, currentSettings);
  chatRightSpeakersCustom = speakerNames.filter((name) => rightSet.has(name));
  chatSidePills.replaceChildren();
  speakerNames.forEach((name) => {
    const pill = el("button", "mqc-chat-side-pill", name);
    pill.type = "button";
    pill.dataset.active = String(rightSet.has(name));
    pill.title = rightSet.has(name) ? `${name} — 오른쪽 (다시 눌러 왼쪽으로)` : `${name} — 왼쪽 (눌러서 오른쪽으로)`;
    pill.addEventListener("click", () => {
      chatSideIsCustom = true;
      const currentlyRight = new Set(chatRightSpeakersCustom);
      if (currentlyRight.has(name)) currentlyRight.delete(name);
      else currentlyRight.add(name);
      chatRightSpeakersCustom = speakerNames.filter((n) => currentlyRight.has(n));
      pill.dataset.active = String(currentlyRight.has(name));
      queueRender();
    });
    chatSidePills.append(pill);
  });
}

function normalizeText(value) {
  return value.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeTypography(value) {
  const withEllipses = value.replace(/\.{2,}/g, "…");
  const chars = Array.from(withEllipses);
  // Straight double quotes toggle open/closed by PARITY (1st → opens, 2nd →
  // closes, 3rd → opens, ...), not by guessing from the previous character.
  // A "does the previous character look dash-like" heuristic misreads a
  // trailing em-dash right before a CLOSING quote — a common way to write
  // interrupted/trailing-off dialogue, e.g. `"...말은—"` — as an OPENING
  // quote instead, because an em-dash right before an opening quote is also
  // a legitimate pattern elsewhere (narration—"dialogue"). Once that single
  // quote gets misclassified, styledCharacters()'s later dialogue-color
  // tracking never finds its expected closer for the rest of the excerpt,
  // so every following line of narration gets mis-colored as dialogue too.
  // Plain alternation has no such ambiguity for well-formed quoted text.
  let doubleQuoteOpen = false;
  return chars
    .map((char, index) => {
      if (char !== '"' && char !== "'") return char;
      if (char === '"') {
        doubleQuoteOpen = !doubleQuoteOpen;
        return doubleQuoteOpen ? "“" : "”";
      }
      const previous = chars[index - 1] || "";
      const next = chars[index + 1] || "";
      const opening = !previous || /[\s([{<—–]/.test(previous);
      if (/\p{L}|\p{N}/u.test(previous) && /\p{L}|\p{N}/u.test(next)) return "’";
      return opening ? "‘" : "’";
    })
    .join("");
}

function applyRegex(text, settings) {
  let result = text;
  for (const rule of settings.regexRules || []) {
    try {
      let pattern = rule.pattern;
      let flags = "g";
      const slashSyntax = pattern.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
      if (slashSyntax) {
        pattern = slashSyntax[1];
        flags = slashSyntax[2].includes("g") ? slashSyntax[2] : `${slashSyntax[2]}g`;
      }
      result = result.replace(new RegExp(pattern, flags), rule.replacement);
    } catch (error) {
      throw new Error(`정규식 오류 (${rule.pattern}): ${error.message}`);
    }
  }
  return result;
}

// Recognizes a KakaoTalk-style pasted chat log — repeating blocks of
// "화자 이름" / "날짜 시간" / 메시지(한 줄 이상), separated by a blank line —
// and pulls out {speaker, message} pairs so it can be rendered as a clean
// transcript instead of being squashed through the free-form prose layout
// (name + timestamp + message all wrapped together reads badly there).
// Full-date shape: "2026. 7. 23. 오후 11:14".
const CHAT_LOG_TIMESTAMP_DATE_SRC =
  "\\d{4}[.\\-/]\\s*\\d{1,2}[.\\-/]\\s*\\d{1,2}\\.?\\s*(?:오전|오후|AM|PM|am|pm)?\\s*\\d{1,2}:\\d{2}(?::\\d{2})?";
// Relative-day shape used by some clients instead of a full date, e.g.
// "Today at 오전 11:39" or "Yesterday at 3:15 PM" (also accepts the Korean
// "오늘"/"어제" spelling and lets "at" be omitted, e.g. "오늘 오전 11:39").
const CHAT_LOG_TIMESTAMP_RELATIVE_SRC =
  "(?:Today|Yesterday|오늘|어제)(?:\\s+at)?\\s*(?:오전|오후|AM|PM|am|pm)?\\s*\\d{1,2}:\\d{2}(?::\\d{2})?";
const CHAT_LOG_TIMESTAMP_CORE_SRC = `(?:${CHAT_LOG_TIMESTAMP_DATE_SRC}|${CHAT_LOG_TIMESTAMP_RELATIVE_SRC})`;
// Whole-line shape: 이름 and 날짜·시간 sit on two separate lines (name line,
// then a line that's nothing BUT the timestamp).
const CHAT_LOG_TIMESTAMP_RE = new RegExp(`^${CHAT_LOG_TIMESTAMP_CORE_SRC}\\s*$`);
// Same-line shape: Marinara's real message markup renders the name and its
// timestamp as adjacent inline elements with no line break between them, so
// a drag-selection's plain-text capture puts them on ONE line — e.g.
// "츠요시2026. 7. 23. 오후 11:06" or "작냥띠니 2026. 7. 20. 오후 8:55" (the
// timestamp trailing right at the end of the line, with or without a space
// before it). The whole-line-only regex above never matched that shape at
// all, so sawTimestamp never tripped and the entire log silently fell back
// to being rendered as plain prose — this was the real cause behind "1명이면
// 대화록/말풍선 안 뜸", not just the block-count check fixed earlier.
const CHAT_LOG_TIMESTAMP_SUFFIX_RE = new RegExp(`${CHAT_LOG_TIMESTAMP_CORE_SRC}\\s*$`);
const CHAT_LOG_NAME_MAX_LENGTH = 24;
const CHAT_LOG_NAME_BAD_ENDING_RE = /[.!?]\s*$/;

function detectChatLog(text) {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  // A single block — one speaker, one message — is still a valid chat log
  // (e.g. excerpting just one KakaoTalk message, or a one-person
  // "monologue" log where every block happens to be the same speaker).
  // Requiring 2+ blocks here rejected that case outright before the
  // per-block parsing even got a chance to check for a real timestamp,
  // which is the actual anti-false-positive signal (see sawTimestamp
  // below) — so this only needs to reject genuinely empty input.
  if (blocks.length < 1) return null;

  // Timestamps are the one unambiguous signal that this is really a pasted
  // chat log rather than an ordinary short-paragraph excerpt — without at
  // least one, stay on the normal prose layout to avoid false positives.
  let sawTimestamp = false;
  const parsed = [];
  for (const rawBlock of blocks) {
    const blockLines = rawBlock
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (blockLines.length < 2) return null;

    let nameLine = blockLines[0];
    let messageLines;
    if (CHAT_LOG_TIMESTAMP_RE.test(blockLines[1])) {
      // Separate-line shape: line 1 is the name, line 2 is nothing but the
      // timestamp.
      sawTimestamp = true;
      messageLines = blockLines.slice(2);
    } else {
      // Same-line shape: check whether line 1 ENDS in a timestamp (the name
      // is whatever precedes it on that line) before falling back to
      // treating the whole of line 1 as just a name with no timestamp.
      const suffixMatch = CHAT_LOG_TIMESTAMP_SUFFIX_RE.exec(nameLine);
      if (suffixMatch) {
        sawTimestamp = true;
        nameLine = nameLine.slice(0, suffixMatch.index).trim();
      }
      messageLines = blockLines.slice(1);
    }

    if (!nameLine || nameLine.length > CHAT_LOG_NAME_MAX_LENGTH || CHAT_LOG_NAME_BAD_ENDING_RE.test(nameLine)) {
      return null;
    }
    if (!messageLines.length) return null;

    parsed.push({ speaker: nameLine, message: messageLines.join("\n") });
  }

  return sawTimestamp ? parsed : null;
}

function styledCharacters(text) {
  const openers = new Map([
    ["“", "”"],
    ["「", "」"],
    ["『", "』"],
    ["«", "»"],
  ]);
  const closers = new Set(openers.values());
  const chars = Array.from(text);
  let expectedCloser = "";
  let asciiQuote = false;
  // *emphasis* and **bold** markers (RP/chat convention for actions or
  // stressed words) are stripped from the rendered text entirely and now
  // get DIFFERENT treatments instead of being folded into one toggle:
  // single-asterisk *emphasis* keeps the existing lighter color fade (see
  // emphasisDialogueColor/emphasisNarrationColor in renderCard), while
  // double-asterisk **bold** gets a slightly bolder weight and a slightly
  // DARKER/more-intense color instead of a lighter one (see
  // boldDialogueColor/boldNarrationColor) — per feedback that "굵게" should
  // read as more intense, not fainter.
  let emphasis = false;
  let bold = false;
  const result = [];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === "*") {
      if (chars[i + 1] === "*") {
        i++;
        bold = !bold;
      } else {
        emphasis = !emphasis;
      }
      continue;
    }
    let dialogue = Boolean(expectedCloser || asciiQuote);
    if (char === '"') {
      dialogue = true;
      asciiQuote = !asciiQuote;
    } else if (openers.has(char)) {
      expectedCloser = openers.get(char);
      dialogue = true;
    } else if (closers.has(char)) {
      dialogue = true;
      if (char === expectedCloser) expectedCloser = "";
    }
    result.push({ char, dialogue, emphasis, bold });
  }
  return result;
}

// *emphasis* stays a color fade only, at the regular weight (italic was
// tried and then deliberately dropped again per feedback). **bold** gets a
// modestly heavier weight (600, not a full 700 — "조금 진하게", not "아주
// 진하게") on top of its own darker color, so it reads as genuinely
// bolder rather than just recolored.
const BOLD_FONT_WEIGHT = 600;
function setTextFont(ctx, fontSize, family, bold = false) {
  ctx.font = `${bold ? BOLD_FONT_WEIGHT : 400} ${fontSize}px ${family}, sans-serif`;
}

// Per-font glyph width cache. Layout measures every character on every
// keystroke; for a long excerpt that was thousands of measureText calls per
// render, almost all of them repeats.
const charWidthCache = new Map();
function measureChar(ctx, char) {
  let widths = charWidthCache.get(ctx.font);
  if (!widths) {
    if (charWidthCache.size > 24) charWidthCache.clear();
    widths = new Map();
    charWidthCache.set(ctx.font, widths);
  }
  let width = widths.get(char);
  if (width === undefined) {
    width = ctx.measureText(char).width;
    widths.set(char, width);
  }
  return width;
}

function layoutStyledLines(ctx, text, maxWidth, fontSize, family) {
  // Font now varies with each run's `bold` flag (600 vs 400 weight), so
  // ctx.font can't be set just once for the whole pass anymore — but it's
  // still only reassigned when the bold state actually flips between runs,
  // not before every single measureText() call, so plain (no **bold**)
  // excerpts pay no extra cost.
  let currentBold = false;
  setTextFont(ctx, fontSize, family, currentBold);
  const lines = [];
  let line = [];
  let width = 0;
  const pushLine = (paragraphEnd = false) => {
    while (line.length && line[line.length - 1].char === " ") {
      width -= line.pop().width;
    }
    lines.push({ runs: line, width, paragraphEnd });
    line = [];
    width = 0;
  };

  const characters = styledCharacters(text);
  const tokens = [];
  let token = [];
  let tokenKind = "";
  const pushToken = () => {
    if (token.length) tokens.push({ kind: tokenKind, runs: token });
    token = [];
  };

  for (const item of characters) {
    const kind = item.char === "\n" ? "newline" : /\s/u.test(item.char) ? "space" : "word";
    if (kind === "newline") {
      pushToken();
      tokens.push({ kind, runs: [item] });
      tokenKind = "";
      continue;
    }
    if (kind !== tokenKind) {
      pushToken();
      tokenKind = kind;
    }
    token.push(item);
  }
  pushToken();

  for (const tokenItem of tokens) {
    if (tokenItem.kind === "newline") {
      pushLine(true);
      continue;
    }

    const measuredRuns = tokenItem.runs.map((item) => {
      if (item.bold !== currentBold) {
        currentBold = item.bold;
        setTextFont(ctx, fontSize, family, currentBold);
      }
      item.width = measureChar(ctx, item.char);
      return item;
    });
    const tokenWidth = measuredRuns.reduce((sum, item) => sum + item.width, 0);

    if (tokenItem.kind === "space") {
      if (line.length) {
        line.push(...measuredRuns);
        width += tokenWidth;
      }
      continue;
    }

    if (line.length && width + tokenWidth > maxWidth) pushLine(false);
    if (tokenWidth <= maxWidth) {
      line.push(...measuredRuns);
      width += tokenWidth;
      continue;
    }

    // A single unbroken token wider than the card is the only case where
    // character-level splitting is unavoidable.
    for (const item of measuredRuns) {
      if (line.length && width + item.width > maxWidth) pushLine(false);
      line.push(item);
      width += item.width;
    }
  }
  if (line.length || !lines.length) pushLine(true);
  return lines;
}

function drawStyledLine(
  ctx,
  line,
  x,
  y,
  maxWidth,
  settings,
  fontSize,
  family,
  dialogueTextColor,
  narrationTextColor,
  emphasisDialogueColor,
  emphasisNarrationColor,
  boldDialogueColor,
  boldNarrationColor,
) {
  const alignment = settings.alignment;
  // Font now varies with each run's `bold` flag — set below as each run is
  // drawn, switching only when the bold state actually flips between runs.
  let currentBold = false;
  setTextFont(ctx, fontSize, family, currentBold);
  let cursor = x;
  let extraSpacing = 0;
  const hasSpaces = line.runs.some((run) => run.char === " ");
  if (alignment === "center") cursor += (maxWidth - line.width) / 2;
  if (alignment === "right") cursor += maxWidth - line.width;
  if (alignment === "justify" && !line.paragraphEnd && line.runs.length > 1) {
    const spaces = line.runs.filter((item) => item.char === " ").length;
    extraSpacing = (maxWidth - line.width) / Math.max(1, spaces || line.runs.length - 1);
  }

  // Pass 1: x position of every run (alignment + justify spacing).
  const xs = new Array(line.runs.length);
  line.runs.forEach((item, index) => {
    xs[index] = cursor;
    cursor += item.width;
    if (extraSpacing && ((hasSpaces && item.char === " ") || (!hasSpaces && index < line.runs.length - 1))) {
      cursor += extraSpacing;
    }
  });

  // Pass 2: glyphs, batched into one fillText per run of identical styling
  // instead of one call per character. A batch is cut wherever justify
  // spacing inserts extra space, so justified text still lines up.
  const colorFor = (item) => {
    // **bold** (darker/more-intense) takes priority over *emphasis*
    // (lighter/fainter) — opposite directions would just cancel out.
    if (item.bold) return item.dialogue ? boldDialogueColor : boldNarrationColor;
    if (item.emphasis) return item.dialogue ? emphasisDialogueColor : emphasisNarrationColor;
    return item.dialogue ? dialogueTextColor : narrationTextColor;
  };
  let batch = "";
  let batchX = 0;
  let batchColor = "";
  let batchBold = false;
  let expectedX = 0;
  const flush = () => {
    if (!batch) return;
    if (batchBold !== currentBold) {
      currentBold = batchBold;
      setTextFont(ctx, fontSize, family, currentBold);
    }
    ctx.fillStyle = batchColor;
    ctx.fillText(batch, batchX, y);
    batch = "";
  };
  line.runs.forEach((item, index) => {
    const color = colorFor(item);
    const contiguous = batch && Math.abs(xs[index] - expectedX) < 0.01;
    if (!contiguous || color !== batchColor || item.bold !== batchBold) {
      flush();
      batchX = xs[index];
      batchColor = color;
      batchBold = item.bold;
    }
    batch += item.char;
    expectedX = xs[index] + item.width;
  });
  flush();
}

function truncateLineAtWord(line) {
  while (line.runs.length && line.runs[line.runs.length - 1].char === " ") {
    line.width -= line.runs.pop().width;
  }
  line.paragraphEnd = true;
}

// Chat-log transcript rendering: speaker names get their own bold "label"
// line at a slightly smaller size, followed by their message line(s) reusing
// the normal prose wrap/measure logic, with a bit of extra breathing room
// between different speakers' blocks.
function speakerFontSize(fontSize) {
  return Math.max(20, Math.round(fontSize * 0.8));
}

function speakerFontString(fontSize, family) {
  return `700 ${fontSize}px ${family}, sans-serif`;
}

function layoutChatRows(ctx, blocks, maxWidth, fontSize, family) {
  const nameFontSize = speakerFontSize(fontSize);
  const rows = [];
  blocks.forEach((block, index) => {
    if (index > 0) rows.push({ kind: "gap" });
    ctx.font = speakerFontString(nameFontSize, family);
    rows.push({ kind: "speaker", text: block.speaker, width: ctx.measureText(block.speaker).width });
    const messageLines = layoutStyledLines(ctx, block.message, maxWidth, fontSize, family);
    messageLines.forEach((line) => rows.push({ ...line, kind: "message" }));
  });
  return rows;
}

function rowHeightFor(row, lineHeight, nameLineHeight, gapHeight) {
  // A "gap" row from bubble mode (layoutBubbleRows) carries its own explicit
  // blockGapHeight, which is deliberately bigger than transcript mode's
  // plain gapHeight — falling back to the generic gapHeight here (ignoring
  // row.height) undercounted every block-to-block gap in bubble mode. That
  // mismatch meant the auto-ratio height calculation (and the truncation
  // walk, which reuses this same function) came out shorter than what the
  // draw loop actually advances by for that same row, so the card ended up
  // too short for its own content and the last bubble spilled into the
  // footer. Transcript-mode "gap" rows never set row.height, so they still
  // fall back to the passed-in gapHeight exactly as before.
  if (row.kind === "gap") return row.height ?? gapHeight;
  if (row.kind === "speaker") return nameLineHeight;
  // Bubble rows carry their own precomputed height (depends on how many
  // wrapped lines fit inside that particular bubble).
  if (row.kind === "bubble" || row.kind === "bubbleGap") return row.height;
  return lineHeight;
}

function drawSpeakerLine(ctx, row, x, y, maxWidth, alignment, color, fontSize, family) {
  ctx.font = speakerFontString(fontSize, family);
  let cursor = x;
  if (alignment === "center") cursor += (maxWidth - row.width) / 2;
  if (alignment === "right") cursor += maxWidth - row.width;
  ctx.fillStyle = color;
  ctx.fillText(row.text, cursor, y);
}

function traceRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// Word-wraps a single line of plain text (no per-character quote/dialogue
// styling — a chat bubble's fill color already carries that distinction) to
// fit maxWidth, falling back to character-level splitting only for a single
// token that's wider than the bubble on its own.
function wrapPlainText(ctx, text, maxWidth, fontSize, family) {
  setTextFont(ctx, fontSize, family);
  const lines = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      if (ctx.measureText(word).width > maxWidth && !current) {
        let chunk = "";
        for (const char of word) {
          const chunkCandidate = chunk + char;
          if (ctx.measureText(chunkCandidate).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = char;
          } else {
            chunk = chunkCandidate;
          }
        }
        current = chunk;
      } else {
        current = candidate;
      }
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

// Messenger-style bubble layout for a detected chat log: each raw message
// line (not the whole block) becomes its own bubble, right-aligned in the
// picked accent color for speakers in rightSpeakerSet, left-aligned in a
// muted neutral tint for everyone else. The speaker name appears once as a
// label above the first bubble of each block.
function layoutBubbleRows(ctx, blocks, maxWidth, fontSize, family, nameFontSize, rightSpeakerSet) {
  const bubbleMaxWidth = Math.round(maxWidth * 0.7);
  const bubblePaddingX = Math.round(fontSize * 0.85);
  const bubblePaddingY = Math.round(fontSize * 0.6);
  const bubbleLineHeight = Math.round(fontSize * 1.3);
  const bubbleGapHeight = Math.round(fontSize * 0.35);
  // Gap between two DIFFERENT speakers' blocks — deliberately much larger
  // than bubbleGapHeight (the gap between two bubbles from the SAME
  // speaker) so a new name label reads as "a new person," not just another
  // bubble crowded under the previous block.
  const blockGapHeight = Math.round(fontSize * 1.4);
  const rows = [];
  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0) rows.push({ kind: "gap", height: blockGapHeight });
    const own = rightSpeakerSet.has(block.speaker);
    ctx.font = speakerFontString(nameFontSize, family);
    rows.push({
      kind: "speaker",
      text: block.speaker,
      width: ctx.measureText(block.speaker).width,
      align: own ? "right" : "left",
      own,
    });
    const messageLines = block.message.split("\n");
    messageLines.forEach((rawLine, lineIndex) => {
      // wrapPlainText already leaves ctx.font set to this exact size/family
      // (it doesn't touch ctx.font again after its own initial assignment),
      // so measuring the wrapped lines below doesn't need to re-set it.
      const wrapped = wrapPlainText(ctx, rawLine, bubbleMaxWidth - bubblePaddingX * 2, fontSize, family);
      const textWidth = Math.max(...wrapped.map((line) => ctx.measureText(line).width));
      const bubbleWidth = Math.min(bubbleMaxWidth, textWidth + bubblePaddingX * 2);
      const bubbleHeight = wrapped.length * bubbleLineHeight + bubblePaddingY * 2;
      rows.push({
        kind: "bubble",
        lines: wrapped,
        width: bubbleWidth,
        height: bubbleHeight,
        own,
        paddingX: bubblePaddingX,
        paddingY: bubblePaddingY,
        lineHeight: bubbleLineHeight,
        fontSize,
      });
      if (lineIndex < messageLines.length - 1) {
        rows.push({ kind: "bubbleGap", height: bubbleGapHeight });
      }
    });
  });
  return rows;
}

// A light/dark accent bubble needs its own text-color decision independent
// of resolveReadableTextColor (which adjusts a color's own lightness for
// legibility against the *card* background) — here the bubble fill IS the
// background, so it's simply "is this fill light enough for dark text".
// WCAG relative luminance / contrast ratio — used instead of a flat HSL
// lightness cutoff because raw lightness misjudges saturated colors (a
// medium-lightness rose/red, for example, has much lower *perceived*
// brightness than its HSL L value suggests, since red is weighted far
// lower than green in relative luminance — a flat 0.6 threshold picked
// black text for exactly that kind of color and made it hard to read).
function relativeLuminanceChannel(value) {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r, g, b) {
  return 0.2126 * relativeLuminanceChannel(r) + 0.7152 * relativeLuminanceChannel(g) + 0.0722 * relativeLuminanceChannel(b);
}

function contrastRatio(luminanceA, luminanceB) {
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

// White text reads cleaner than dark gray on virtually any saturated or
// mid-tone accent color in practice — matching how colored message bubbles
// look in most chat apps (iMessage, WhatsApp, KakaoTalk all default to white
// text on a colored bubble). A raw "pick whichever side has the higher WCAG
// contrast ratio" comparison actually favors dark gray text on a warm
// mid-tone like a dusty rose (its own hue has a fairly high per-channel
// luminance weight even at a middling HSL lightness) — which is exactly the
// case reported as "hard to read" — so white is the default, and dark text
// only kicks in once white's OWN contrast against the bubble color drops
// below a usable floor (the accent is pale/bright enough — a light pastel,
// a bright yellow — that white text would genuinely wash out against it).
const BUBBLE_WHITE_TEXT_MIN_CONTRAST = 2.5;

function resolveOwnBubbleTextColor(accentHex) {
  const rgb = hexToRgb(accentHex) || hexToRgb(FALLBACK_ACCENT_HEX);
  if (!rgb) return "#ffffff";
  const bgLuminance = relativeLuminance(rgb.r, rgb.g, rgb.b);
  const whiteContrast = contrastRatio(bgLuminance, relativeLuminance(0xff, 0xff, 0xff));
  return whiteContrast < BUBBLE_WHITE_TEXT_MIN_CONTRAST ? "#262626" : "#ffffff";
}

function drawBubbleRow(ctx, row, x, y, maxWidth, bubbleColors, family) {
  const bubbleX = row.own ? x + maxWidth - row.width : x;
  const colors = row.own ? bubbleColors.own : bubbleColors.other;
  ctx.fillStyle = colors.bubble;
  traceRoundedRect(ctx, bubbleX, y, row.width, row.height, Math.min(26, row.height / 2, row.width / 2));
  ctx.fill();

  setTextFont(ctx, row.fontSize, family);
  ctx.fillStyle = colors.text;
  let textY = y + row.paddingY + row.fontSize * 0.85;
  row.lines.forEach((line) => {
    ctx.fillText(line, bubbleX + row.paddingX, textY);
    textY += row.lineHeight;
  });
}

// Paints the card background and the decoration for settings.cardStyle.
// Everything is drawn inside a rounded clip so the PNG's outer corners stay
// alpha-transparent. Returns { skipDivider } for styles that draw their own
// footer separator.
const CARD_OUTER_RADIUS = 48;
function drawCardDecor(ctx, settings, layout) {
  const { width: w, height: h, sideMargin, textTop, fontSize, lineHeight, dividerY } = layout;
  const bg = settings.backgroundColor;
  const accent = settings.dialogueColor;
  const dark = isDarkHex(bg);
  const style = CARD_STYLE_KEYS.has(settings.cardStyle) ? settings.cardStyle : "classic";
  const result = { skipDivider: false };

  ctx.save();
  traceRoundedRect(ctx, 0, 0, w, h, CARD_OUTER_RADIUS);
  ctx.clip();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  if (style === "classic") {
    // Thin accent stripe across the top edge + rounded accent border.
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, w, 6);
    ctx.lineWidth = 3;
    ctx.strokeStyle = accent;
    traceRoundedRect(ctx, 26, 26, w - 52, h - 52, 42);
    ctx.stroke();
  } else if (style === "quote") {
    // Oversized faded quotation marks in the corners.
    ctx.fillStyle = hexToRgba(accent, dark ? 0.35 : 0.22);
    ctx.font = `700 260px Georgia, "Times New Roman", serif`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText("“", sideMargin - 34, 250);
    const closeWidth = ctx.measureText("”").width;
    ctx.fillText("”", w - sideMargin - closeWidth + 34, dividerY + 120);
  } else if (style === "note") {
    // Ruled notebook paper: lines on the text baselines, a margin rule and
    // binder holes down the left edge.
    const ruleColor = dark ? "rgba(255,255,255,0.1)" : "rgba(60,90,140,0.14)";
    ctx.strokeStyle = ruleColor;
    ctx.lineWidth = 2;
    const firstBaseline = textTop + fontSize + fontSize * 0.32;
    const step = layout.ruledLines ? lineHeight : Math.round(fontSize * 1.45);
    let lineY = firstBaseline;
    while (lineY - step > 70) lineY -= step;
    for (; lineY < dividerY - 12; lineY += step) {
      ctx.beginPath();
      ctx.moveTo(48, lineY);
      ctx.lineTo(w - 40, lineY);
      ctx.stroke();
    }
    ctx.strokeStyle = hexToRgba(accent, 0.55);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(sideMargin - 22, 0);
    ctx.lineTo(sideMargin - 22, h);
    ctx.stroke();
    ctx.globalCompositeOperation = "destination-out";
    for (let holeY = 120; holeY < h - 80; holeY += 180) {
      ctx.beginPath();
      ctx.arc(30, holeY, 11, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  } else if (style === "frame") {
    // Tinted mat around an inset panel, like a framed print.
    ctx.fillStyle = mixHexColors(bg, accent, dark ? 0.28 : 0.2);
    ctx.fillRect(0, 0, w, h);
    ctx.shadowColor = "rgba(0,0,0,0.18)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = bg;
    traceRoundedRect(ctx, 38, 38, w - 76, h - 76, 18);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = hexToRgba(accent, 0.5);
    ctx.lineWidth = 1.5;
    traceRoundedRect(ctx, 52, 52, w - 104, h - 104, 10);
    ctx.stroke();
  } else if (style === "ticket") {
    // Dashed border, and notches punched out where the stub (footer) starts.
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 10]);
    traceRoundedRect(ctx, 26, 26, w - 52, h - 52, 30);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(56, dividerY);
    ctx.lineTo(w - 56, dividerY);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.globalCompositeOperation = "destination-out";
    [0, w].forEach((x) => {
      ctx.beginPath();
      ctx.arc(x, dividerY, 30, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";
    result.skipDivider = true;
  } else if (style === "glow") {
    // Soft diagonal wash toward the accent plus two blurred light pools.
    const wash = ctx.createLinearGradient(0, 0, w, h);
    wash.addColorStop(0, bg);
    wash.addColorStop(1, mixHexColors(bg, accent, dark ? 0.35 : 0.28));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h);
    [
      [w * 0.88, h * 0.08, Math.max(w, h) * 0.45],
      [w * 0.05, h * 0.92, Math.max(w, h) * 0.4],
    ].forEach(([x, y, r]) => {
      const pool = ctx.createRadialGradient(x, y, 0, x, y, r);
      pool.addColorStop(0, hexToRgba(accent, dark ? 0.35 : 0.3));
      pool.addColorStop(1, hexToRgba(accent, 0));
      ctx.fillStyle = pool;
      ctx.fillRect(0, 0, w, h);
    });
  } else if (style === "film") {
    // Film-strip bars with sprocket holes along the top and bottom edges.
    const barHeight = 40;
    ctx.fillStyle = dark ? "#000000" : "#16161a";
    ctx.fillRect(0, 0, w, barHeight);
    ctx.fillRect(0, h - barHeight, w, barHeight);
    ctx.fillStyle = dark ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.85)";
    for (let x = 34; x < w - 20; x += 52) {
      traceRoundedRect(ctx, x, 13, 22, 14, 3);
      ctx.fill();
      traceRoundedRect(ctx, x, h - 27, 22, 14, 3);
      ctx.fill();
    }
  } else if (style === "grid") {
    // Graph paper: a fine square grid, every 5th line slightly stronger.
    const cell = 36;
    ctx.lineWidth = 1;
    for (let i = 0; i * cell <= Math.max(w, h); i++) {
      const pos = i * cell + 0.5;
      ctx.strokeStyle = dark
        ? `rgba(255,255,255,${i % 5 ? 0.05 : 0.11})`
        : hexToRgba(accent, i % 5 ? 0.1 : 0.22);
      ctx.beginPath();
      if (pos <= w) {
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, h);
      }
      if (pos <= h) {
        ctx.moveTo(0, pos);
        ctx.lineTo(w, pos);
      }
      ctx.stroke();
    }
  } else if (style === "tape") {
    // Two strips of masking tape holding the card by its top corners.
    const drawTape = (cx, cy, angle) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.fillStyle = hexToRgba(accent, dark ? 0.55 : 0.42);
      ctx.fillRect(-120, -26, 240, 52);
      ctx.fillStyle = dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.32)";
      for (let x = -120; x < 120; x += 24) ctx.fillRect(x, -26, 9, 52);
      ctx.restore();
    };
    drawTape(78, 58, -Math.PI / 5);
    drawTape(w - 78, 58, Math.PI / 5);
  }
  // "minimal": background only.

  ctx.restore();
  return result;
}

// `options.scale` (1/2/3, see EXPORT_SCALES) controls the RASTER resolution
// this particular render pass draws at — it does NOT come from
// settings.exportScale by default. Every render triggered by typing or
// clicking a control (queueRender → renderCard()) uses the default (1×) so
// the interactive preview always draws the same, small, fast canvas
// regardless of what export size the person has picked — only the explicit
// "PNG 저장" click passes the real chosen scale (see the saveButton handler),
// so the expensive full-resolution raster work happens once per save instead
// of on every keystroke/click. This used to always render at
// settings.exportScale, which made every single edit while 2×/3× was
// selected redraw a 2×–3× larger canvas (fillText per character, stroke,
// etc.) — reported as the UI feeling laggy/stuttery while editing.
async function renderCard(options = {}) {
  const sequence = ++renderSequence;
  const settings = settingsFromControls();
  saveSettings(settings);
  const ratioKey = settings.ratio in RATIOS ? settings.ratio : "portrait";
  const isAutoRatio = ratioKey === "auto";
  const ratioWidth = CARD_WIDTH;

  const family = settings.font ? `"${settings.font.replaceAll('"', '\\"')}"` : "Inter";
  const requestedFontSize = FONT_SIZES[settings.fontSizeLevel - 1] || FONT_SIZES[2];
  // Keyed by family+size, not just size — now that `family` can vary per
  // card (see settings.font above), a plain size-only key would wrongly
  // report a different font already "loaded" just because some other font
  // was confirmed at that same size earlier.
  const fontLoadKey = `${family}:${requestedFontSize}`;
  if (!loadedFontSizes.has(fontLoadKey)) {
    try {
      await document.fonts?.load?.(`400 ${requestedFontSize}px ${family}`);
      loadedFontSizes.add(fontLoadKey);
      // Widths cached before this font finished loading were measured with
      // the fallback font.
      charWidthCache.clear();
      layoutCache = { key: "", rows: [] };
      lastPreviewKey = "";
    } catch {
      // Canvas will fall back to the next available font; don't cache this
      // size as "loaded" so we retry on a later render.
    }
  }
  if (sequence !== renderSequence) return null;

  const sideMargin = 86;
  const maxWidth = ratioWidth - sideMargin * 2;
  let processedText = normalizeText(textArea.value);
  let regexError = "";
  try {
    processedText = normalizeTypography(applyRegex(processedText, settings));
  } catch (error) {
    regexError = error.message;
  }

  const fontSize = requestedFontSize;
  const lineHeight = Math.round(fontSize * 1.45);

  // measureText only needs a 2d context with the right font set — the
  // offscreen context is used for measuring without ever being resized.
  const measureCtx = offscreenCtx;
  if (!measureCtx || !previewCtx) return canvas;

  // A pasted KakaoTalk-style chat log (이름 / 날짜시간 / 메시지 blocks) gets a
  // dedicated transcript or bubble layout instead of being squashed through
  // the normal prose wrap — see detectChatLog(). Prose rows are tagged
  // "message" too, so the height/truncation math below is a single shared
  // code path for all three layouts.
  const chatBlocks = detectChatLog(processedText);
  updateChatControls(chatBlocks, settings);
  const nameFontSize = speakerFontSize(fontSize);
  const nameLineHeight = Math.round(nameFontSize * 1.3);
  const gapHeight = Math.round(lineHeight * 0.6);
  const isBubbleMode = Boolean(chatBlocks) && settings.chatLayoutStyle === "bubble";
  // Footer (divider line + label) is pinned near the bottom of the card
  // instead of being centered together with the body text — footerReserve is
  // the vertical space it always occupies just above the bottom padding, so
  // short excerpts don't leave the footer stranded high up with empty space
  // below it. Bubble mode gets extra breathing room: a rounded, solid-filled
  // bubble sitting right at the same fixed gap that works for a thin text
  // baseline reads as visually cramped against the divider.
  const footerReserve = isBubbleMode ? 108 : 80;
  const rightSpeakerSet = isBubbleMode
    ? resolveRightSpeakerSet(uniqueSpeakerNames(chatBlocks), settings)
    : new Set();
  // Line breaking depends only on the text, font and layout mode — colors,
  // background, card design, footer and alignment don't move a single line —
  // so the wrapped rows are reused until one of those inputs changes.
  const layoutKey = [
    processedText,
    family,
    fontSize,
    isBubbleMode ? "bubble" : chatBlocks ? "transcript" : "prose",
    [...rightSpeakerSet].join("\u0001"),
  ].join("\u0000");
  if (layoutCache.key !== layoutKey) {
    let laidOut;
    if (isBubbleMode) {
      laidOut = layoutBubbleRows(measureCtx, chatBlocks, maxWidth, fontSize, family, nameFontSize, rightSpeakerSet);
    } else if (chatBlocks) {
      laidOut = layoutChatRows(measureCtx, chatBlocks, maxWidth, fontSize, family);
    } else {
      laidOut = layoutStyledLines(measureCtx, processedText, maxWidth, fontSize, family).map((line) => ({
        ...line,
        kind: "message",
      }));
    }
    layoutCache = { key: layoutKey, rows: laidOut };
  }
  let rows = layoutCache.rows;

  let ratioHeight;
  let topMargin;
  let bottomMargin;
  const rowsHeight = (rowList) => rowList.reduce((sum, row) => sum + rowHeightFor(row, lineHeight, nameLineHeight, gapHeight), 0);
  if (isAutoRatio) {
    // Fixed (not percentage-of-height) margins so short excerpts don't get
    // padded out with a lot of empty top/bottom space.
    topMargin = 96;
    bottomMargin = 64;
    const contentHeight = rowsHeight(rows) + footerReserve;
    ratioHeight = Math.min(
      AUTO_RATIO_MAX_HEIGHT,
      Math.max(AUTO_RATIO_MIN_HEIGHT, topMargin + contentHeight + bottomMargin),
    );
  } else {
    const ratio = RATIOS[ratioKey] || RATIOS.portrait;
    ratioHeight = ratio.height;
    topMargin = Math.round(ratioHeight * 0.09);
    bottomMargin = Math.round(ratioHeight * 0.06);
  }
  const usableHeight = ratioHeight - topMargin - bottomMargin;
  const maxTextHeight = usableHeight - footerReserve;
  // Rows have mixed heights (message/speaker/gap), so truncation walks and
  // accumulates actual row heights rather than dividing by one fixed height.
  let acc = 0;
  let cutIndex = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const h = rowHeightFor(rows[i], lineHeight, nameLineHeight, gapHeight);
    if (acc + h > maxTextHeight) {
      cutIndex = i;
      break;
    }
    acc += h;
  }
  if (cutIndex < rows.length) {
    rows = rows.slice(0, cutIndex);
    // Don't end the card on a dangling speaker name or a trailing gap.
    while (
      rows.length &&
      (rows[rows.length - 1].kind === "gap" ||
        rows[rows.length - 1].kind === "speaker" ||
        rows[rows.length - 1].kind === "bubbleGap")
    ) {
      rows.pop();
    }
    if (rows.length && rows[rows.length - 1].kind === "message") {
      // Copy before trimming — the original row belongs to the layout cache.
      const lastRow = rows[rows.length - 1];
      rows[rows.length - 1] = { ...lastRow, runs: lastRow.runs.slice() };
      truncateLineAtWord(rows[rows.length - 1]);
    }
    // Bubble rows are only ever included whole (the accumulation above only
    // adds a row once its full height is confirmed to fit), so no partial
    // bubble ever needs to be truncated the way an overflowing prose line
    // does — the trailing-gap/speaker cleanup above is enough.
    if (!rows.length) rows = [{ kind: "message", runs: [], width: 0, paragraphEnd: true }];
  }

  // renderScale is THIS render pass's raster multiplier — see the big
  // comment on the function signature above. It intentionally does NOT read
  // settings.exportScale directly; only an explicit caller-provided
  // options.scale (the saveButton handler, at the moment of actually saving)
  // bumps it above 1×. Every draw call below keeps using logical
  // ratioWidth/ratioHeight-space coordinates exactly as before — setTransform
  // scales that whole coordinate system up (including stroke widths and
  // fillText's glyph size) so a save at 2×/3× still comes out at N× the
  // pixels without touching a single x/y/fontSize elsewhere in this
  // function.
  // Exports (options.scale given) draw the full-resolution file offscreen.
  // The preview draws straight into the visible canvas at roughly the pixel
  // size it's displayed at — a tall card shown a few hundred pixels wide no
  // longer gets a full 1080-wide raster (a 1080×7922 preview was ~34MB).
  const isExport = options.scale !== undefined;
  const renderScale = isExport
    ? EXPORT_SCALES.includes(options.scale)
      ? options.scale
      : 1
    : previewPixelScale(ratioHeight);
  // Nothing visible changed (e.g. the same segment clicked again) — keep
  // the current preview instead of repainting the whole card.
  const renderKey = `${layoutKey}\u0000${JSON.stringify(settings)}\u0000${selectedChatTitle}\u0000${ratioHeight}\u0000${renderScale}`;
  if (!isExport && renderKey === lastPreviewKey) return canvas;
  const target = isExport ? offscreenCanvas : canvas;
  const ctx = isExport ? offscreenCtx : previewCtx;
  target.width = Math.round(ratioWidth * renderScale);
  target.height = Math.round(ratioHeight * renderScale);
  if (!isExport) lastPreviewKey = renderKey;
  // Resizing a canvas clears it and resets context state (including the
  // transform) to identity, so this is safe to set unconditionally right
  // after the resize above.
  ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);

  // Body text is centered only within the space ABOVE the reserved footer
  // zone, so the footer itself always stays pinned near the bottom.
  const totalHeight = rowsHeight(rows);
  const textAreaHeight = usableHeight - footerReserve;
  const textTop = topMargin + Math.max(0, (textAreaHeight - totalHeight) / 2);
  let y = textTop + fontSize;
  const labelBaseline = ratioHeight - bottomMargin;
  const dividerY = labelBaseline - 46;
  // Background + the picked 카드 디자인's decoration (see drawCardDecor). The
  // outer corners stay alpha-transparent in the saved PNG.
  const decor = drawCardDecor(ctx, settings, {
    width: ratioWidth,
    height: ratioHeight,
    sideMargin,
    textTop,
    fontSize,
    lineHeight,
    dividerY,
    ruledLines: !chatBlocks,
  });
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  // Computed once per render (not per line/character) — both are pure
  // functions of the two settings colors, so hoisting them out of the loop
  // avoids redundant HSL math on every line.
  const dialogueTextColor = resolveReadableTextColor(settings.dialogueColor, settings.backgroundColor);
  const narrationTextColor = resolveReadableTextColor(
    settings.textColor,
    settings.backgroundColor,
    NARRATION_DARK_BG_MIN_LIGHTNESS,
    NARRATION_LIGHT_BG_MAX_LIGHTNESS,
  );
  // *emphasis*/**emphasis** runs (see styledCharacters) fade toward the
  // card's own background instead of using a separate fixed color — this
  // keeps them recognizably "the same text, just quieter" whether they fall
  // inside dialogue or narration, and automatically stays legible on dark
  // cards too since it's blending toward whatever background is picked.
  const EMPHASIS_FADE_RATIO = 0.45;
  const emphasisDialogueColor = mixHexColors(dialogueTextColor, settings.backgroundColor, EMPHASIS_FADE_RATIO);
  const emphasisNarrationColor = mixHexColors(narrationTextColor, settings.backgroundColor, EMPHASIS_FADE_RATIO);
  // **bold** runs go the opposite direction from *emphasis* — a small nudge
  // AWAY from the background instead of toward it, so they read as more
  // intense/"진하게" rather than fainter. On a light card that's a nudge
  // toward black (darker); on a dark card, nudging toward black would
  // actually read as LOWER contrast against the already-dark background, so
  // it nudges toward white instead — either way it's "away from the
  // background," which is the actual intent. Kept deliberately small
  // ("조금 진하게", not "아주 진하게") — see BOLD_INTENSIFY_RATIO.
  const BOLD_INTENSIFY_RATIO = 0.22;
  const boldIntensifyTarget = isDarkHex(settings.backgroundColor) ? "#ffffff" : "#000000";
  const boldDialogueColor = mixHexColors(dialogueTextColor, boldIntensifyTarget, BOLD_INTENSIFY_RATIO);
  const boldNarrationColor = mixHexColors(narrationTextColor, boldIntensifyTarget, BOLD_INTENSIFY_RATIO);
  // Bubble fill colors: my ("own"/right) bubble is a low-alpha neutral tint
  // of the card background (연회색) so it reads as a subtle bubble either
  // way, the other person's ("other"/left) bubble is a solid fill of the raw
  // picked accent (not the auto-contrasted dialogueTextColor — that's tuned
  // for text drawn directly on the card background, not for a bubble that
  // *is* the background).
  const isDarkCard = isDarkHex(settings.backgroundColor);
  const bubbleColors = {
    own: { bubble: isDarkCard ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.05)", text: narrationTextColor },
    other: { bubble: settings.dialogueColor, text: resolveOwnBubbleTextColor(settings.dialogueColor) },
  };
  rows.forEach((row) => {
    if (row.kind === "gap" || row.kind === "bubbleGap") {
      y += row.height ?? gapHeight;
      return;
    }
    if (row.kind === "speaker") {
      const alignment = row.align || settings.alignment;
      // Bubble mode: the label color matches its own side's bubble accent —
      // my (own/right, now gray) bubble gets a muted label, the other
      // person's (left, accent-colored) bubble gets the accent label.
      // Transcript mode has no "own" concept, so every label stays accented.
      const labelColor = row.own === undefined ? dialogueTextColor : row.own ? narrationTextColor : dialogueTextColor;
      drawSpeakerLine(ctx, row, sideMargin, y, maxWidth, alignment, labelColor, nameFontSize, family);
      y += nameLineHeight;
      return;
    }
    if (row.kind === "bubble") {
      drawBubbleRow(ctx, row, sideMargin, y, maxWidth, bubbleColors, family);
      y += row.height;
      return;
    }
    drawStyledLine(
      ctx,
      row,
      sideMargin,
      y,
      maxWidth,
      settings,
      fontSize,
      family,
      dialogueTextColor,
      narrationTextColor,
      emphasisDialogueColor,
      emphasisNarrationColor,
      boldDialogueColor,
      boldNarrationColor,
    );
    y += lineHeight;
  });

  // Footer: a thin divider line, then a single label line below it — the
  // chat/character title, the plain "MARINARA" wordmark, or a person-typed
  // custom string, never more than one at once — switchable via "하단 라벨".
  // Pinned to the bottom padding line rather than glued directly under the
  // body text.
  if (!decor.skipDivider) {
    ctx.save();
    ctx.strokeStyle = isDarkHex(settings.backgroundColor) ? "#ffffff" : "#000000";
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sideMargin, dividerY);
    ctx.lineTo(ratioWidth - sideMargin, dividerY);
    ctx.stroke();
    ctx.restore();
  }

  // Same font stack as the body text (family + generic sans-serif fallback)
  // so "MARINARA" and the character-name label render consistently instead
  // of picking up different fallback fonts per script.
  setTextFont(ctx, 28, family);
  if (settings.footerLabel === "marinara") {
    ctx.fillStyle = resolveReadableTextColor(
      "#858287",
      settings.backgroundColor,
      NARRATION_DARK_BG_MIN_LIGHTNESS,
      NARRATION_LIGHT_BG_MAX_LIGHTNESS,
    );
    ctx.fillText("MARINARA", sideMargin, labelBaseline);
  } else {
    // Same computation as narrationTextColor above (identical params), so
    // reuse it instead of recomputing the HSL adjustment a second time.
    ctx.fillStyle = narrationTextColor;
    // "직접입력": the person's own typed footer text. An empty custom field
    // falls back to the title (same as "캐릭터 이름" mode) rather than
    // drawing a blank footer line.
    const customText = settings.footerLabel === "custom" ? settings.footerLabelCustomText?.trim() : "";
    ctx.fillText(customText || selectedChatTitle || "캐릭터", sideMargin, labelBaseline);
  }

  const chatStatusSuffix = chatBlocks ? (isBubbleMode ? " · 대화 로그 (말풍선)" : " · 대화 로그 (대화록)") : "";
  // Informational only — reflects the person's SAVED 저장 배율 preference
  // (settings.exportScale), not renderScale (which this particular pass
  // rendered at, almost always 1× — see the function's opening comment). The
  // actual high-res pixels only get drawn once, at save time.
  const preferredExportScale = EXPORT_SCALES.includes(settings.exportScale) ? settings.exportScale : 1;
  const exportSuffix =
    preferredExportScale > 1
      ? ` (저장 시 ${ratioWidth * preferredExportScale}×${ratioHeight * preferredExportScale}px)`
      : "";
  status.textContent =
    regexError || `${ratioWidth} × ${ratioHeight}px · 본문 ${fontSize}px${chatStatusSuffix}${exportSuffix}`;
  return target;
}

// Pixel scale for the preview canvas: its on-screen width (capped by the
// pane and by its max-height for tall cards) times devicePixelRatio, rounded
// up to 5% steps so small layout changes don't force a repaint. Never below
// 0.3 so the preview stays legible, never above 1 (the file's own size).
function previewPixelScale(ratioHeight) {
  const paneWidth = previewPane.clientWidth;
  const paneHeight = previewPane.clientHeight;
  if (!paneWidth || !paneHeight) return 1;
  const shownWidth = Math.min(500, paneWidth, (paneHeight * CARD_WIDTH) / ratioHeight);
  const scale = (shownWidth * (window.devicePixelRatio || 1)) / CARD_WIDTH;
  return Math.min(1, Math.max(0.3, Math.ceil(scale * 20) / 20));
}

// Clicks re-render right away (several changes in the same tick still
// coalesce into one render); typing passes a short delay so a burst of
// keystrokes renders once. A timer rather than requestAnimationFrame, which
// stalls whenever the page is in the background.
let renderTimer = 0;
function queueRender(delay = 0) {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => void renderCard(), delay);
}
const TYPING_RENDER_DELAY = 120;
const queueTypingRender = () => queueRender(TYPING_RENDER_DELAY);

function closeModal() {
  overlay.style.display = "none";
  flushSettings();
}

async function openModal() {
  if (!selectedRange || overlay.style.display === "flex") return;
  selectedText = normalizeText(extractSelectionText(selectedRange));
  if (!selectedText) return;
  selectedChatTitle = resolveChatTitle();
  selectionButton.style.display = "none";
  textArea.value = selectedText;
  const settings = loadSettings();
  status.textContent = "폰트 불러오는 중…";
  overlay.style.display = "flex";
  // The preview doesn't wait on /api/fonts — the saved font is drawn right
  // away and the dropdown fills in when the list arrives.
  populateFonts(settings.font);
  void loadFonts().then((changed) => {
    if (!changed || overlay.style.display !== "flex") return;
    const before = fontSelect.value;
    populateFonts(before);
    if (fontSelect.value !== before) queueRender();
  });
  setActiveSegment(ratioSegments, settings.ratio in RATIOS ? settings.ratio : "portrait");
  setActiveSegment(
    exportScaleSegments,
    EXPORT_SCALES.includes(Number(settings.exportScale)) ? String(settings.exportScale) : "1",
  );
  setActiveSegment(
    alignmentSegments,
    ["left", "center", "justify", "right"].includes(settings.alignment) ? settings.alignment : "left",
  );
  const migratedLevel =
    Number(settings.fontSizeLevel) ||
    FONT_SIZES.reduce(
      (best, size, index) =>
        Math.abs(size - Number(settings.fontSize || FONT_SIZES[2])) <
        Math.abs(FONT_SIZES[best - 1] - Number(settings.fontSize || FONT_SIZES[2]))
          ? index + 1
          : best,
      1,
    );
  sizeLevelDisplay.textContent = String(Math.min(5, Math.max(1, migratedLevel)));
  setColorFieldValue(textColorField, settings.textColor || "#ffffff");

  // Re-resolve the site's live theme accent every time the modal opens
  // (instead of relying on a value computed once at page load), so a theme
  // switch is picked up immediately without needing a reload.
  const themeAccentHex = resolveThemeColorHex("--primary", FALLBACK_ACCENT_HEX);
  refreshThemeBackgroundPreset(themeAccentHex);

  // By key, so "테마" keeps following the theme. A key from an older version
  // that no longer exists (e.g. "직접") falls back to matching the hex.
  const savedPreset =
    BACKGROUND_PRESETS.find((preset) => preset.key === settings.backgroundPresetKey) ||
    BACKGROUND_PRESETS.find((preset) => preset.hex && preset.hex === settings.backgroundColor);
  setActiveBackgroundPreset(savedPreset ? savedPreset.key : "white");
  setActiveSegment(cardStyleGrid, CARD_STYLE_KEYS.has(settings.cardStyle) ? settings.cardStyle : DEFAULTS.cardStyle);
  showTab(settings.dialogTab);

  dialogueColorIsCustom = settings.dialogueColorMode === "custom";
  const restoredDialogueColor = dialogueColorIsCustom ? settings.dialogueColor || themeAccentHex : themeAccentHex;
  setColorFieldValue(dialogueColorField, restoredDialogueColor);

  setActiveSegment(
    footerLabelSegments,
    settings.footerLabel === "marinara" || settings.footerLabel === "custom" ? settings.footerLabel : "title",
  );
  footerCustomLabelInput.value = settings.footerLabelCustomText || "";

  setActiveSegment(chatStyleSegments, settings.chatLayoutStyle === "bubble" ? "bubble" : "transcript");
  chatSideIsCustom = settings.chatSideMode === "custom";
  chatRightSpeakersCustom = Array.isArray(settings.chatRightSpeakers) ? [...settings.chatRightSpeakers] : [];
  lastChatSpeakersKey = null; // force the 말풍선 방향 pills to rebuild for this fresh selection

  regexList.replaceChildren();
  const storedRules = Array.isArray(settings.regexRules)
    ? settings.regexRules
    : settings.regexEnabled && settings.regexPattern
      ? [{ pattern: settings.regexPattern, replacement: settings.regexReplacement || "" }]
      : [];
  storedRules.forEach((rule) => addRegexRule(rule.pattern || "", rule.replacement || ""));
  if (!storedRules.length) addRegexRule();
  await renderCard();
}

// --- Selection button -----------------------------------------------------------

function hideSelectionButton() {
  selectionButton.style.display = "none";
}

function currentSelectionRange() {
  const selection = window.getSelection();
  return selectionIsInChat(selection) ? selection.getRangeAt(0) : null;
}

// Sits on the same row as Marinara's "로어북에 추가" button when that button
// is showing (to its right, else its left, else just under it); otherwise
// centered just below the selection, flipping above it near the bottom edge.
function positionSelectionButton(range) {
  selectionButton.style.display = "flex";
  const width = selectionButton.offsetWidth;
  const height = selectionButton.offsetHeight;
  const gap = 6;
  const edge = 8;
  const rect = range.getBoundingClientRect();
  const nativeRect = document.querySelector(NATIVE_SELECTION_BUTTON_SELECTOR)?.getBoundingClientRect();
  let left;
  let top;
  if (nativeRect && nativeRect.width) {
    top = nativeRect.top + (nativeRect.height - height) / 2;
    if (nativeRect.right + gap + width <= window.innerWidth - edge) {
      left = nativeRect.right + gap;
    } else if (nativeRect.left - gap - width >= edge) {
      left = nativeRect.left - gap - width;
    } else {
      left = nativeRect.left + nativeRect.width / 2 - width / 2;
      top = nativeRect.bottom + gap;
    }
  } else {
    left = rect.left + rect.width / 2 - width / 2;
    top = rect.bottom + 8;
    if (top + height > window.innerHeight - edge) top = rect.top - height - 8;
  }
  selectionButton.style.left = `${Math.min(window.innerWidth - width - edge, Math.max(edge, left))}px`;
  selectionButton.style.top = `${Math.min(window.innerHeight - height - edge, Math.max(edge, top))}px`;
}

function updateSelectionButton() {
  if (overlay.style.display === "flex" || openingFromPointer) return;
  const range = currentSelectionRange();
  const rect = range?.getBoundingClientRect();
  // Same rule as Marinara's own button: nothing for a selection that's
  // invisible or scrolled fully out of view.
  if (!rect || (!rect.width && !rect.height) || rect.bottom < 0 || rect.top > window.innerHeight) {
    hideSelectionButton();
    return;
  }
  // Only the range is kept here — the (more expensive) styled text
  // extraction runs once, when the button is actually pressed.
  selectedRange = range.cloneRange();
  positionSelectionButton(range);
}

// Marinara's own selection button follows scrolling, so ours does too
// (it used to stay put and drift away from the text).
let repositionFrame = 0;
function repositionOnScroll() {
  if (selectionButton.style.display !== "flex") return;
  cancelAnimationFrame(repositionFrame);
  repositionFrame = requestAnimationFrame(updateSelectionButton);
}

// --- Chat title ---------------------------------------------------------------

function activeChatId() {
  try {
    const stored = localStorage.getItem(ACTIVE_CHAT_ID_KEY);
    if (stored) return stored;
  } catch {
    // Fall through to the composer's attribute.
  }
  return document.querySelector("textarea[data-chat-id]")?.dataset.chatId || "";
}

// 2.5.0 dropped the sidebar markup the old lookup used, so the title now
// comes from /api/chats/:id (cached per chat). The first call for a chat
// returns the fallback and re-renders once the request lands.
const chatTitleCache = new Map();
function resolveChatTitle() {
  const chatId = activeChatId();
  if (chatId && chatTitleCache.has(chatId)) return chatTitleCache.get(chatId);
  if (chatId && /^[\w-]+$/.test(chatId)) {
    apiJson(`/chats/${chatId}`)
      .then((chat) => {
        const name = String(chat?.name || "").trim();
        if (!name) return;
        chatTitleCache.set(chatId, name);
        if (activeChatId() !== chatId) return;
        selectedChatTitle = name;
        if (overlay.style.display === "flex") queueRender();
      })
      .catch(() => {});
  }
  const explicitTitle = document.querySelector("[data-active-chat-title], [data-chat-title]");
  if (explicitTitle?.textContent?.trim()) return explicitTitle.textContent.trim();
  return "캐릭터";
}

function scheduleSelectionUpdate(delay = 120) {
  window.clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(updateSelectionButton, delay);
}

// --- Event wiring -----------------------------------------------------------------

const isEditableTarget = (target) => Boolean(target?.closest?.("input, textarea, [contenteditable='true']"));
marinaraCompat.on(document, "selectionchange", () => scheduleSelectionUpdate(180));
marinaraCompat.on(document, "pointerup", () => scheduleSelectionUpdate(80));
marinaraCompat.on(document, "touchend", () => scheduleSelectionUpdate(220));
marinaraCompat.on(document, "keyup", (event) => {
  if (!isEditableTarget(event.target)) scheduleSelectionUpdate(0);
});
marinaraCompat.on(document, "pointerdown", (event) => {
  if (!selectionButton.contains(event.target)) hideSelectionButton();
});
marinaraCompat.on(window, "scroll", repositionOnScroll, { capture: true, passive: true });
marinaraCompat.on(
  window,
  "resize",
  () => {
    repositionOnScroll();
    if (overlay.style.display === "flex") queueRender(TYPING_RENDER_DELAY);
  },
  { passive: true },
);

marinaraCompat.on(selectionButton, "pointerdown", (event) => {
  openingFromPointer = true;
  event.preventDefault();
  event.stopPropagation();
  window.clearTimeout(selectionTimer);
  void openModal().finally(() => {
    openingFromPointer = false;
  });
});
marinaraCompat.on(selectionButton, "touchstart", (event) => {
  if (overlay.style.display === "flex" || openingFromPointer) return;
  openingFromPointer = true;
  event.preventDefault();
  event.stopPropagation();
  window.clearTimeout(selectionTimer);
  void openModal().finally(() => {
    openingFromPointer = false;
  });
});
marinaraCompat.on(selectionButton, "click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  void openModal();
});
marinaraCompat.on(closeButton, "click", closeModal);
marinaraCompat.on(cancelButton, "click", closeModal);
marinaraCompat.on(overlay, "click", (event) => {
  if (event.target === overlay) closeModal();
});
marinaraCompat.on(document, "keydown", (event) => {
  if (event.key !== "Escape") return;
  if (overlay.style.display === "flex") closeModal();
});
marinaraCompat.on(textArea, "input", queueTypingRender);
marinaraCompat.on(fontSelect, "change", () => queueRender());

// Segmented-control groups (이미지 비율, 본문 정렬, 하단 라벨, 채팅 로그
// 스타일, 저장 배율, 카드 디자인, 배경) share the same "click a segment → activate
// it → re-render" wiring.
function wireSegmentClicks(container) {
  marinaraCompat.on(container, "click", (event) => {
    const button = event.target.closest(".mqc-segment[data-value]");
    if (!button) return;
    setActiveSegment(container, button.dataset.value);
    queueRender();
  });
}
[
  ratioSegments,
  alignmentSegments,
  footerLabelSegments,
  chatStyleSegments,
  exportScaleSegments,
  cardStyleGrid,
].forEach(wireSegmentClicks);
marinaraCompat.on(tabBar, "click", (event) => {
  const tab = event.target.closest(".mqc-tab[data-tab]");
  if (!tab) return;
  showTab(tab.dataset.tab);
  saveSettings(settingsFromControls());
});
marinaraCompat.on(backgroundPresetGrid, "click", (event) => {
  const button = event.target.closest(".mqc-preset[data-preset-key]");
  if (!button) return;
  setActiveBackgroundPreset(button.dataset.presetKey);
  queueRender();
});
// footerCustomLabelInput is itself one of 하단 라벨's segments — clicking it
// already activates "custom" via wireSegmentClicks above. These cover
// keyboard focus and typing, which need to (re)activate it too.
marinaraCompat.on(footerCustomLabelInput, "focus", () => {
  setActiveSegment(footerLabelSegments, "custom");
  queueRender();
});
marinaraCompat.on(footerCustomLabelInput, "input", () => {
  setActiveSegment(footerLabelSegments, "custom");
  queueTypingRender();
});

marinaraCompat.on(sizeMinusButton, "click", () => {
  sizeLevelDisplay.textContent = String(Math.max(1, Number(sizeLevelDisplay.textContent) - 1));
  queueRender();
});
marinaraCompat.on(sizePlusButton, "click", () => {
  sizeLevelDisplay.textContent = String(Math.min(5, Number(sizeLevelDisplay.textContent) + 1));
  queueRender();
});
marinaraCompat.on(dialogueColorField.input, "input", () => {
  // Manually editing 대사/테두리 색상 stops it from following the site theme
  // until the next fresh selection (see dialogueColorMode in openModal()).
  dialogueColorIsCustom = true;
  syncColorFieldDisplay(dialogueColorField);
  queueTypingRender();
});
marinaraCompat.on(textColorField.input, "input", () => {
  syncColorFieldDisplay(textColorField);
  queueTypingRender();
});
marinaraCompat.on(regexAddButton, "click", () => addRegexRule());

// PNG encoding of a 2×/3× card can take seconds, so the button shows it's
// busy and ignores repeat clicks until the file is out.
let saving = false;
marinaraCompat.on(saveButton, "click", async () => {
  if (saving) return;
  saving = true;
  saveButton.disabled = true;
  // The full-resolution raster is drawn once, right when 저장 is clicked.
  const requestedScale = Number(activeSegmentValue(exportScaleSegments, "1")) || 1;
  const rendered = await renderCard({ scale: requestedScale });
  flushSettings();
  // Set after the render, which writes its own size line into status.
  status.textContent = "PNG 만드는 중…";
  const blob = rendered
    ? await new Promise((resolve) => {
        rendered.toBlob(resolve, "image/png");
        // toBlob() snapshots the pixels synchronously, so the export raster
        // (up to ~75MB at 3×) can be released right away.
        rendered.width = 0;
        rendered.height = 0;
      })
    : null;
  saving = false;
  saveButton.disabled = false;
  if (!blob) {
    status.textContent = "이미지를 저장하지 못했습니다.";
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const number = nextDownloadNumber();
  anchor.href = url;
  anchor.download = `marinara-${number}.png`;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  pendingDownloadUrls.add(url);
  marinara.setTimeout(() => {
    URL.revokeObjectURL(url);
    pendingDownloadUrls.delete(url);
  }, 60_000);
  status.textContent = "PNG를 저장했습니다.";
});

marinara.onCleanup(() => {
  window.clearTimeout(renderTimer);
  window.clearTimeout(selectionTimer);
  cancelAnimationFrame(repositionFrame);
  flushSettings();
  fontRequestController.abort();
  pendingDownloadUrls.forEach((url) => URL.revokeObjectURL(url));
  pendingDownloadUrls.clear();
  cleanupTasks.splice(0).forEach((task) => {
    try {
      task();
    } catch {
      // Keep tearing down the rest.
    }
  });
});
