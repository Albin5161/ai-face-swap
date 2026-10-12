// ─── Config ───────────────────────────────────────────────────────────────────

const SERVER = "http://localhost:3000"

// ─── Storage ──────────────────────────────────────────────────────────────────

async function storageGet(keys: string[]): Promise<Record<string, unknown>> {
  try {
    const result = await chrome.storage.local.get(keys)
    console.log("[AIR] storage.get", keys, "→", result)
    return result
  } catch (err) {
    console.error("[AIR] storage.get error:", err)
    return {}
  }
}

// Resolves false when the write failed (usually: storage is full).
async function storageSet(items: Record<string, unknown>): Promise<boolean> {
  try {
    await chrome.storage.local.set(items)
    console.log("[AIR] storage.set", Object.keys(items))
    return true
  } catch (err) {
    console.error("[AIR] storage.set error:", err)
    return false
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function hash(str: string): string {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = Math.imul(h, 33) ^ str.charCodeAt(i)
  return (h >>> 0).toString(36)
}

const CACHE_PREFIX = "fsc_"

// Keyed by face AND target, so a new face photo never gets an old result.
function cacheKey(sourceDataUrl: string, targetUrl: string) {
  return `${CACHE_PREFIX}${hash(sourceDataUrl)}_${hash(targetUrl)}`
}

async function clearSwapCache(): Promise<void> {
  try {
    const all = await chrome.storage.local.get()
    const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX))
    if (keys.length) await chrome.storage.local.remove(keys)
    console.log("[AIR] cleared swap cache —", keys.length, "entries")
  } catch (err) {
    console.error("[AIR] clearSwapCache error:", err)
  }
}

// Saved results belong to the old face — drop them when the photo changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.replacerImage !== undefined) clearSwapCache()
})

// ─── Local server call ────────────────────────────────────────────────────────

async function callLocalServer(
  targetUrl: string,
  sourceDataUrl: string,
  log?: (msg: string) => void
): Promise<string> {
  const endpoint = `${SERVER}/faceswap`
  log?.(`→ POST ${endpoint}`)
  console.log("[AIR] Calling local server:", endpoint)

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUrl, sourceDataUrl })
    })
  } catch {
    throw new Error("Can't reach the local server. Start it and try again.")
  }

  const json = await res.json() as { success: boolean; dataUrl?: string; error?: string }
  log?.(`← ${res.status}: ${json.success ? "success" : json.error}`)
  console.log("[AIR] Server response:", res.status, json.success ? "ok" : json.error)

  if (!res.ok || !json.success) {
    throw new Error(json.error ?? `Server error (${res.status})`)
  }
  if (!json.dataUrl) throw new Error("Server returned no dataUrl")
  return json.dataUrl
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // ── TEST_API: tests the local server directly from the popup ─────────────
  if (message.type === "TEST_API") {
    ;(async () => {
      const log: string[] = []
      const push = (msg: string) => { log.push(msg); console.log("[AIR TEST]", msg) }

      try {
        // 1. Read storage
        const stored = await storageGet(["replacerImage"])
        const sourceDataUrl = stored.replacerImage

        if (typeof sourceDataUrl !== "string" || !sourceDataUrl)
          throw new Error("No source face image saved — upload one in the popup first.")

        push(`✓ Source image loaded (${Math.round((sourceDataUrl as string).length / 1024)} KB)`)

        // 2. Health check
        push(`→ GET ${SERVER}/health`)
        const healthRes = await fetch(`${SERVER}/health`)
        const healthJson = await healthRes.json() as { ok: boolean; error?: string; facefusionDir?: string }
        push(`← ${healthRes.status}: ${JSON.stringify(healthJson)}`)
        if (!healthRes.ok || !healthJson.ok)
          throw new Error(healthJson.error ?? "Local server not healthy")
        push(`✓ Server healthy — FaceFusion at ${healthJson.facefusionDir}`)

        // 3. Run face swap — use source as both source and target for a self-contained test
        push("→ Running test face swap (source used as both source and target)…")
        const dataUrl = await callLocalServer(
          sourceDataUrl as string,  // data: URL — server handles this path directly
          sourceDataUrl as string,
          push
        )
        push(`✓ Done! Result is ${Math.round(dataUrl.length / 1024)} KB data URL`)
        sendResponse({ success: true, log, resultUrl: dataUrl })

      } catch (err) {
        push(`✗ ${(err as Error).message}`)
        sendResponse({ success: false, log, error: (err as Error).message })
      }
    })()
    return true
  }

  // ── FACE_SWAP: called from content script per selected image ──────────────
  if (message.type === "FACE_SWAP") {
    const { targetUrl } = message as { targetUrl: string }

    ;(async () => {
      try {
        console.log("[AIR] FACE_SWAP for:", targetUrl)
        const stored = await storageGet(["replacerImage"])
        const sourceDataUrl = stored.replacerImage

        if (typeof sourceDataUrl !== "string" || !sourceDataUrl)
          throw new Error("No face photo saved. Upload one in the popup first.")

        // Persistent cache
        const key = cacheKey(sourceDataUrl, targetUrl)
        const cached = await storageGet([key])
        if (typeof cached[key] === "string") {
          console.log("[AIR] Cache hit for", targetUrl)
          sendResponse({ success: true, url: cached[key] })
          return
        }

        const dataUrl = await callLocalServer(targetUrl, sourceDataUrl as string)
        // Storage full: drop old results and try once more. The swap still shows either way.
        if (!(await storageSet({ [key]: dataUrl }))) {
          await clearSwapCache()
          await storageSet({ [key]: dataUrl })
        }
        sendResponse({ success: true, url: dataUrl })

      } catch (err) {
        console.error("[AIR] FACE_SWAP error:", (err as Error).message)
        sendResponse({ success: false, error: (err as Error).message })
      }
    })()
    return true
  }

  return false
})
