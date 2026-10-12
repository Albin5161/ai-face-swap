import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://*/*"],
  run_at: "document_idle"
}

// ─── Debug ────────────────────────────────────────────────────────────────────

// Set true to show a 200px "[AIR DEBUG RESULT]" panel beside the original.
const DEBUG = false

// ─── State ────────────────────────────────────────────────────────────────────

let isEnabled    = false
let inSelectMode = false
let selectTarget: HTMLImageElement | null = null

const inFlight     = new WeakSet<HTMLImageElement>()
const replaced     = new WeakSet<HTMLImageElement>()
const sessionCache = new Map<string, string>()   // targetUrl → dataUrl

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_PX = 300

const SKIP_KEYWORDS = [
  "logo", "icon", "badge", "avatar", "sprite", "brand", "symbol",
  "thumb", "thumbnail", "bullet", "star", "rating", "flag", "arrow",
  "button", "banner-small", "favicon"
]

const SKIP_SELECTORS =
  "nav, header, footer, [role='banner'], [role='navigation'], " +
  "[role='complementary'], [aria-label='breadcrumb']"

// Framework lazy-load attrs to strip after swap
const LAZY_ATTRS = [
  "data-src", "data-srcset", "data-lazy", "data-lazy-src",
  "data-original", "data-nimg", "data-image-src", "data-splide-lazy"
]

// ─── Storage ──────────────────────────────────────────────────────────────────

function storageGet(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) return resolve({})
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) return resolve({})
      resolve(result)
    })
  })
}

// ─── CSS injection ────────────────────────────────────────────────────────────

let cssInjected = false
function ensureCSS() {
  if (cssInjected || !document.head) return
  cssInjected = true
  const s = document.createElement("style")
  s.textContent = `
    @keyframes _air_pulse {
      0%,100% { opacity:.35; filter:grayscale(.6) brightness(.6); }
      50%      { opacity:.15; filter:grayscale(.9) brightness(.4); }
    }
    ._air_loading {
      animation: _air_pulse 1.3s ease-in-out infinite !important;
      cursor: progress !important;
      pointer-events: none !important;
    }
    body._air_select_mode *:not(._air_loading) { cursor: crosshair !important; }
  `
  document.head.appendChild(s)
}

// ─── Resolve best target URL ──────────────────────────────────────────────────

// currentSrc = the actually-loaded URL chosen by the browser from srcset/picture.
// Falls back to data-src (lazy), then src.
function resolveTargetUrl(img: HTMLImageElement): string {
  if (img.currentSrc && !img.currentSrc.startsWith("data:")) return img.currentSrc
  if (img.src        && !img.src.startsWith("data:"))        return img.src
  for (const attr of LAZY_ATTRS) {
    const v = img.getAttribute(attr)
    if (v && !v.startsWith("data:")) return v.split(",")[0].trim().split(" ")[0]
  }
  return img.src
}

// ─── Image eligibility ────────────────────────────────────────────────────────

function isSelectable(img: HTMLImageElement): boolean {
  if (inFlight.has(img) || replaced.has(img)) return false
  const url = resolveTargetUrl(img)
  if (!url || url === window.location.href) return false
  if (url.startsWith("data:image/svg") || url.endsWith(".svg")) return false

  const rect = img.getBoundingClientRect()
  const w = rect.width  || (img.complete ? img.naturalWidth  : 0)
  const h = rect.height || (img.complete ? img.naturalHeight : 0)
  if (w < MIN_PX || h < MIN_PX) return false

  const probe = [img.className, img.alt, img.id, url].join(" ").toLowerCase()
  if (SKIP_KEYWORDS.some((kw) => probe.includes(kw))) return false
  if (img.closest(SKIP_SELECTORS)) return false
  return true
}

// ─── Loading animation ────────────────────────────────────────────────────────

function setLoading(img: HTMLImageElement, on: boolean) {
  ensureCSS()
  img.classList.toggle("_air_loading", on)
}

// ─── Hover overlay ────────────────────────────────────────────────────────────

let overlayEl: HTMLDivElement | null = null

function getOverlay(): HTMLDivElement {
  if (overlayEl) return overlayEl
  overlayEl = document.createElement("div")
  overlayEl.id = "_air_sel_overlay"
  Object.assign(overlayEl.style, {
    position: "fixed", pointerEvents: "none", zIndex: "2147483647",
    display: "none", alignItems: "center", justifyContent: "center",
    border: "2px solid rgba(139,92,246,.9)", borderRadius: "10px",
    background: "rgba(109,40,217,.18)", boxShadow: "0 0 0 4px rgba(139,92,246,.12)"
  })
  overlayEl.innerHTML =
    `<span style="background:rgba(0,0,0,.72);color:#fff;font:600 12px/-apple-system,sans-serif;` +
    `padding:5px 12px;border-radius:6px;pointer-events:none;white-space:nowrap">` +
    `✦ Click to swap face</span>`
  document.body.appendChild(overlayEl)
  return overlayEl
}

function showOverlay(img: HTMLImageElement) {
  const r = img.getBoundingClientRect()
  const el = getOverlay()
  Object.assign(el.style, {
    display: "flex",
    left: `${r.left}px`, top: `${r.top}px`,
    width: `${r.width}px`, height: `${r.height}px`
  })
}
function hideOverlay() { if (overlayEl) overlayEl.style.display = "none" }

// ─── Mode badge ───────────────────────────────────────────────────────────────

let badgeEl: HTMLDivElement | null = null
function getBadge(): HTMLDivElement {
  if (badgeEl) return badgeEl
  badgeEl = document.createElement("div")
  badgeEl.id = "_air_sel_badge"
  Object.assign(badgeEl.style, {
    position: "fixed", bottom: "20px", right: "20px",
    background: "rgba(109,40,217,.95)", color: "#fff",
    font: "600 12px -apple-system,sans-serif", padding: "8px 16px",
    borderRadius: "999px", zIndex: "2147483647",
    boxShadow: "0 4px 16px rgba(0,0,0,.35)", pointerEvents: "none",
    letterSpacing: ".02em", display: "none"
  })
  badgeEl.textContent = "✦ Select an image · ESC to cancel"
  document.body.appendChild(badgeEl)
  return badgeEl
}
function showBadge() { getBadge().style.display = "block" }
function hideBadge() { if (badgeEl) badgeEl.style.display = "none" }

// ─── Error toast ──────────────────────────────────────────────────────────────

let toastEl: HTMLDivElement | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined

function showError(message: string) {
  if (!toastEl) {
    toastEl = document.createElement("div")
    toastEl.id = "_air_toast"
    toastEl.setAttribute("role", "alert")
    Object.assign(toastEl.style, {
      position: "fixed", bottom: "20px", right: "20px", maxWidth: "320px",
      background: "rgba(9,9,15,.96)", color: "#fff",
      font: "500 12px/1.45 -apple-system,sans-serif", padding: "10px 16px",
      border: "1px solid rgba(248,113,113,.6)", borderRadius: "12px",
      zIndex: "2147483647", boxShadow: "0 4px 16px rgba(0,0,0,.35)",
      pointerEvents: "none", display: "none"
    })
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = `Face swap failed: ${message}`
  toastEl.style.display = "block"
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { if (toastEl) toastEl.style.display = "none" }, 6000)
}

// ─── Style snapshot ───────────────────────────────────────────────────────────

interface StyleSnapshot {
  objectFit:       string
  objectPosition:  string
  borderRadius:    string
  transform:       string
  display:         string
  position:        string
  inlineStyle:     string   // full original style="" attribute
}

function snapshotStyles(img: HTMLImageElement): StyleSnapshot {
  const c = window.getComputedStyle(img)
  return {
    objectFit:      c.objectFit      || "cover",
    objectPosition: c.objectPosition || "center",
    borderRadius:   c.borderRadius   || "",
    transform:      c.transform !== "none" ? c.transform : "",
    display:        c.display        || "inline-block",
    position:       c.position       || "static",
    inlineStyle:    img.getAttribute("style") ?? ""
  }
}

// Re-apply only the layout-critical inline styles so the image stays in frame.
// We do NOT set width/height in pixels — the original CSS (% / absolute) handles that.
function reapplyLayoutStyles(img: HTMLImageElement, snap: StyleSnapshot) {
  // Restore the original inline style first (catches Next.js position:absolute etc.)
  if (snap.inlineStyle) img.setAttribute("style", snap.inlineStyle)
  // Then pin object-fit / object-position so the data URL fills correctly
  img.style.objectFit      = snap.objectFit
  img.style.objectPosition = snap.objectPosition
  if (snap.borderRadius) img.style.borderRadius = snap.borderRadius
  if (snap.transform)    img.style.transform    = snap.transform
  // Ensure opacity is restored (we fade in after this call)
  img.style.opacity    = "0"
  img.style.transition = "opacity .35s ease"
}

// ─── picture > source handling ────────────────────────────────────────────────

function disablePictureSources(img: HTMLImageElement) {
  const picture = img.closest("picture")
  if (!picture) return
  picture.querySelectorAll("source").forEach((src) => {
    src.setAttribute("srcset", "")
    src.removeAttribute("media")
    src.removeAttribute("sizes")
  })
  console.log("[AIR] disabled <picture><source> tags")
}

// ─── Lazy-load attr cleanup ───────────────────────────────────────────────────

function clearLazyAttrs(img: HTMLImageElement) {
  for (const attr of LAZY_ATTRS) {
    if (img.hasAttribute(attr)) {
      img.removeAttribute(attr)
      console.log(`[AIR] cleared lazy attr: ${attr}`)
    }
  }
}

// ─── Debug panel ──────────────────────────────────────────────────────────────

function appendDebugPanel(img: HTMLImageElement, dataUrl: string) {
  if (!DEBUG) return
  const id = "_air_dbg_" + Math.random().toString(36).slice(2)
  // Remove old panel for this img if any
  img.parentElement?.querySelector("[data-air-debug]")?.remove()

  const wrap = document.createElement("div")
  wrap.setAttribute("data-air-debug", "1")
  Object.assign(wrap.style, {
    position: "fixed",
    bottom: "80px",
    right: "16px",
    zIndex: "2147483646",
    background: "#09090f",
    border: "2px solid #7c3aed",
    borderRadius: "12px",
    padding: "8px",
    boxShadow: "0 8px 32px rgba(0,0,0,.6)",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    alignItems: "center"
  })

  const label = document.createElement("span")
  label.textContent = "[AIR DEBUG RESULT]"
  Object.assign(label.style, {
    color: "#a78bfa",
    font: "600 10px -apple-system,sans-serif",
    letterSpacing: ".06em",
    textTransform: "uppercase"
  })

  const preview = document.createElement("img")
  preview.src = dataUrl
  preview.id  = id
  Object.assign(preview.style, {
    width: "200px",
    height: "auto",
    borderRadius: "8px",
    display: "block"
  })

  const close = document.createElement("button")
  close.textContent = "✕ dismiss"
  Object.assign(close.style, {
    background: "none",
    border: "none",
    color: "#6b7280",
    font: "11px -apple-system,sans-serif",
    cursor: "pointer",
    padding: "2px 0"
  })
  close.addEventListener("click", () => wrap.remove())

  wrap.append(label, preview, close)
  document.body.appendChild(wrap)
  console.log("[AIR] debug panel shown (fixed bottom-right)")
}

// ─── React/framework rerender guard ──────────────────────────────────────────

function guardAgainstRerender(img: HTMLImageElement, dataUrl: string, snap: StyleSnapshot) {
  let count = 0
  const obs = new MutationObserver(() => {
    const srcOk   = img.src === dataUrl
    const srcsetOk = img.srcset === "" || img.srcset === dataUrl
    if (srcOk && srcsetOk) return
    if (count++ >= 15) { obs.disconnect(); return }
    console.log(`[AIR] rerender reverted src — re-applying (${count})`)
    img.src    = dataUrl
    img.srcset = ""
    img.sizes  = ""
    reapplyLayoutStyles(img, snap)
    img.style.opacity = "1"
  })
  obs.observe(img, {
    attributes: true,
    attributeFilter: ["src", "srcset", "style"]
  })
  setTimeout(() => obs.disconnect(), 12_000)
}

// ─── Core replacement ─────────────────────────────────────────────────────────

function applyResult(img: HTMLImageElement, dataUrl: string) {
  console.log("[AIR] replacing DOM image —", resolveTargetUrl(img).slice(0, 80))

  setLoading(img, false)
  replaced.add(img)

  // 1. Snapshot styles BEFORE touching the element
  const snap = snapshotStyles(img)
  console.log("[AIR] style snapshot:", snap.objectFit, snap.position, snap.inlineStyle.slice(0, 60))

  // 2. Neutralise competing <picture><source> elements
  disablePictureSources(img)

  // 3. Remove framework lazy-load attributes
  clearLazyAttrs(img)

  // 4. Start fade-out without touching layout properties
  img.style.transition = "opacity .35s ease"
  img.style.opacity    = "0"

  let applied = false
  const doSwap = () => {
    if (applied) return
    applied = true

    // 5. Restore original inline style (preserves position:absolute etc.)
    //    then override only what we need
    reapplyLayoutStyles(img, snap)

    // 6. Set the swapped image src — keep all layout CSS intact
    img.src    = dataUrl
    img.srcset = ""
    img.sizes  = ""
    img.removeAttribute("data-nimg")

    // 7. Reveal on load (or immediately on error)
    const reveal = () => {
      img.style.opacity = "1"
      console.log("[AIR] replacement applied ✓")
      appendDebugPanel(img, dataUrl)
      guardAgainstRerender(img, dataUrl, snap)
    }
    img.addEventListener("load",  reveal, { once: true })
    img.addEventListener("error", () => {
      console.warn("[AIR] replacement failed — img load error")
      img.style.opacity = "1"
      appendDebugPanel(img, dataUrl)
    }, { once: true })
  }

  // Fire on transition end; fallback after 450 ms for sites that block transitions
  img.addEventListener("transitionend", doSwap, { once: true })
  setTimeout(doSwap, 450)
}

// ─── Face swap request ────────────────────────────────────────────────────────

function requestFaceSwap(img: HTMLImageElement) {
  if (inFlight.has(img) || replaced.has(img)) return

  const targetUrl = resolveTargetUrl(img)
  console.log("[AIR] image detected —", targetUrl.slice(0, 100))

  if (sessionCache.has(targetUrl)) {
    console.log("[AIR] session cache hit")
    inFlight.add(img)
    applyResult(img, sessionCache.get(targetUrl)!)
    syncExitToStorage()
    return
  }

  inFlight.add(img)
  setLoading(img, true)
  console.log("[AIR] sending FACE_SWAP →", targetUrl.slice(0, 100))

  chrome.runtime.sendMessage(
    { type: "FACE_SWAP", targetUrl },
    (res: { success: boolean; url?: string; error?: string } | undefined) => {
      if (chrome.runtime.lastError || !res) {
        console.warn("[AIR] runtime error:", chrome.runtime.lastError?.message)
        setLoading(img, false)
        inFlight.delete(img)
        showError("The extension did not respond. Reload this page and try again.")
        return
      }
      if (res.success && res.url) {
        console.log("[AIR] swap completed — dataUrl length:", res.url.length)
        sessionCache.set(targetUrl, res.url)
        applyResult(img, res.url)
        syncExitToStorage()
      } else {
        console.warn("[AIR] swap failed:", res.error)
        setLoading(img, false)
        inFlight.delete(img)
        showError(res.error ?? "Something went wrong.")
      }
    }
  )
}

// ─── Select mode ──────────────────────────────────────────────────────────────

function syncExitToStorage() {
  chrome?.storage?.local?.set({ replacerSelectMode: false })
}

function onHover(e: MouseEvent) {
  const img = e.target
  if (!(img instanceof HTMLImageElement) || !isSelectable(img)) {
    hideOverlay(); selectTarget = null; return
  }
  selectTarget = img
  showOverlay(img)
}

function onOut(e: MouseEvent) {
  if (e.relatedTarget instanceof HTMLImageElement) return
  selectTarget = null
  hideOverlay()
}

function onClick(e: MouseEvent) {
  const img = e.target
  if (!(img instanceof HTMLImageElement) || !isSelectable(img)) return
  e.preventDefault()
  e.stopPropagation()
  hideOverlay()
  exitSelectMode({ writeStorage: true })
  requestFaceSwap(img)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") exitSelectMode({ writeStorage: true })
}

function onScroll() {
  if (selectTarget) showOverlay(selectTarget)
}

function enterSelectMode() {
  if (inSelectMode) return
  inSelectMode = true
  ensureCSS()
  document.body.classList.add("_air_select_mode")
  document.addEventListener("mouseover", onHover)
  document.addEventListener("mouseout",  onOut)
  document.addEventListener("click",     onClick, true)
  document.addEventListener("keydown",   onKeydown)
  window .addEventListener("scroll",    onScroll, true)
  showBadge()
}

function exitSelectMode({ writeStorage }: { writeStorage: boolean }) {
  if (!inSelectMode) return
  inSelectMode = false
  document.body.classList.remove("_air_select_mode")
  document.removeEventListener("mouseover", onHover)
  document.removeEventListener("mouseout",  onOut)
  document.removeEventListener("click",     onClick, true)
  document.removeEventListener("keydown",   onKeydown)
  window .removeEventListener("scroll",    onScroll, true)
  hideOverlay()
  hideBadge()
  selectTarget = null
  if (writeStorage) syncExitToStorage()
}

// ─── Storage listener ─────────────────────────────────────────────────────────

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.replacerEnabled !== undefined) {
      isEnabled = Boolean(changes.replacerEnabled.newValue)
      if (!isEnabled) exitSelectMode({ writeStorage: false })
    }
    if (changes.replacerSelectMode !== undefined) {
      const want = Boolean(changes.replacerSelectMode.newValue)
      if (want && isEnabled) enterSelectMode()
      else exitSelectMode({ writeStorage: false })
    }
    if (changes.replacerImage !== undefined) sessionCache.clear()
  })
}

// ─── Init ─────────────────────────────────────────────────────────────────────

storageGet(["replacerEnabled", "replacerSelectMode"]).then((result) => {
  isEnabled = result.replacerEnabled === true
  if (isEnabled && result.replacerSelectMode === true) enterSelectMode()
})
