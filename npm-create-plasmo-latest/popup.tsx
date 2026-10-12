import { useEffect, useRef, useState } from "react"
import "./popup.css"

// ─── Storage ──────────────────────────────────────────────────────────────────

const storage = {
  async get(keys: string[]): Promise<Record<string, unknown>> {
    try {
      const result = await chrome.storage.local.get(keys)
      console.log("[AIR] popup storage.get", keys, "→", result)
      return result
    } catch (err) {
      console.error("[AIR] popup storage.get error:", err)
      return {}
    }
  },
  // Resolves false when the write failed (usually: storage is full).
  async set(items: Record<string, unknown>): Promise<boolean> {
    try {
      await chrome.storage.local.set(items)
      console.log("[AIR] popup storage.set", Object.keys(items), "✓")
      return true
    } catch (err) {
      console.error("[AIR] popup storage.set error:", err)
      return false
    }
  }
}

// ─── Photo resize ─────────────────────────────────────────────────────────────

// Extension storage is small, and the swap model only uses a small face crop,
// so shrink the photo before saving it.
const MAX_PHOTO_PX = 1024

function resizePhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale  = Math.min(1, MAX_PHOTO_PX / Math.max(img.naturalWidth, img.naturalHeight))
      const canvas = document.createElement("canvas")
      canvas.width  = Math.round(img.naturalWidth  * scale)
      canvas.height = Math.round(img.naturalHeight * scale)
      const ctx = canvas.getContext("2d")
      if (!ctx) return reject(new Error("Canvas not available"))
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL("image/jpeg", 0.9))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("Could not read that image"))
    }
    img.src = url
  })
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SaveStatus = "idle" | "saved" | "error"
type TestStatus = "idle" | "running" | "success" | "error"

// ─── Component ────────────────────────────────────────────────────────────────

function IndexPopup() {
  const [imageData,    setImageData]    = useState<string | null>(null)
  const [saveStatus,   setSaveStatus]   = useState<SaveStatus>("idle")
  const [isEnabled,    setIsEnabled]    = useState(false)
  const [isSelectMode, setIsSelectMode] = useState(false)

  const [testStatus,    setTestStatus]    = useState<TestStatus>("idle")
  const [testLog,       setTestLog]       = useState<string[]>([])
  const [testResultUrl, setTestResultUrl] = useState<string | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  // ── Load persisted state ──────────────────────────────────────────────────

  useEffect(() => {
    storage
      .get(["replacerImage", "replacerEnabled", "replacerSelectMode"])
      .then((r) => {
        if (typeof r.replacerImage      === "string")  setImageData(r.replacerImage)
        if (typeof r.replacerEnabled    === "boolean") setIsEnabled(r.replacerEnabled)
        if (typeof r.replacerSelectMode === "boolean") setIsSelectMode(r.replacerSelectMode)
      })
  }, [])

  // Live-sync: content script can deactivate select mode (ESC / successful swap)
  useEffect(() => {
    if (!chrome?.storage?.onChanged) return
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.replacerSelectMode !== undefined) {
        setIsSelectMode(Boolean(changes.replacerSelectMode.newValue))
      }
      if (changes.replacerEnabled !== undefined) {
        setIsEnabled(Boolean(changes.replacerEnabled.newValue))
      }
    }
    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }, [])

  // Auto-scroll test log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [testLog])

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    resizePhoto(file)
      .then((dataUrl) => {
        setImageData(dataUrl)
        setSaveStatus("idle")
      })
      .catch((err) => {
        console.error("[AIR] popup resize error:", err)
        setSaveStatus("error")
      })
  }

  const handleSavePhoto = async () => {
    if (!imageData) return
    const ok = await storage.set({ replacerImage: imageData })
    setSaveStatus(ok ? "saved" : "error")
    if (ok) setTimeout(() => setSaveStatus("idle"), 2000)
  }

  const handleToggleEnable = async () => {
    const next = !isEnabled
    setIsEnabled(next)
    await storage.set({ replacerEnabled: next })
    // Turning off the master switch also deactivates select mode
    if (!next && isSelectMode) {
      setIsSelectMode(false)
      await storage.set({ replacerSelectMode: false })
    }
  }

  const handleToggleSelect = async () => {
    if (!isEnabled) return          // require master switch to be on
    const next = !isSelectMode
    setIsSelectMode(next)
    await storage.set({ replacerSelectMode: next })
  }

  const handleTestApi = () => {
    setTestStatus("running")
    setTestLog(["Starting standalone API test…"])
    setTestResultUrl(null)

    chrome.runtime.sendMessage(
      { type: "TEST_API" },
      (res: { success: boolean; log: string[]; resultUrl?: string; error?: string }) => {
        if (chrome.runtime.lastError) {
          setTestLog((l) => [...l, `✗ Runtime error: ${chrome.runtime.lastError?.message}`])
          setTestStatus("error")
          return
        }
        setTestLog(res.log ?? [])
        setTestStatus(res.success ? "success" : "error")
        if (res.success) setTestResultUrl(res.resultUrl ?? null)
      }
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="bg-[#09090f] p-5 font-sans" style={{ width: 350 }}>

      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center shrink-0 shadow-lg shadow-violet-900/40">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="4" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </div>
        <div>
          <h1 className="text-white text-[15px] font-semibold leading-tight tracking-tight">
            AI Face Swap
          </h1>
          <p className="text-gray-500 text-[11px] mt-0.5">
            Powered by FaceFusion · runs locally
          </p>
        </div>
      </div>

      <div className="h-px bg-white/[0.05] mb-4" />

      {/* Source Face */}
      <div className="bg-[#111118] rounded-2xl p-4 mb-3 border border-white/[0.06]">
        <p className="text-gray-500 text-[10px] font-semibold uppercase tracking-[0.12em] mb-3">
          Source Face
        </p>

        {imageData ? (
          <div className="relative mb-3 group rounded-xl overflow-hidden">
            <img src={imageData} alt="Preview" className="w-full h-[110px] object-cover" />
            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <span className="text-white/80 text-xs font-medium">Upload new to replace</span>
            </div>
          </div>
        ) : (
          <div className="w-full h-[110px] bg-white/[0.025] rounded-xl flex flex-col items-center justify-center mb-3 border border-dashed border-white/[0.08]">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
              stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-2">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
            </svg>
            <p className="text-gray-600 text-xs">Upload your face photo</p>
          </div>
        )}

        <label className="w-full flex items-center justify-center gap-2 bg-white/[0.04] hover:bg-white/[0.07] text-gray-300 hover:text-white text-[13px] font-medium py-2.5 px-4 rounded-xl cursor-pointer transition-all duration-150 border border-white/[0.06]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          {imageData ? "Change Photo" : "Upload Photo"}
          <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
        </label>

        {imageData && (
          <button onClick={handleSavePhoto}
            className={`w-full mt-2 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-200 ${
              saveStatus === "saved"
                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25"
                : "bg-violet-600/15 hover:bg-violet-600/25 text-violet-400 border border-violet-500/20"
            }`}>
            {saveStatus === "saved" ? "✓ Photo saved" : "Save Photo"}
          </button>
        )}

        {saveStatus === "error" && (
          <p className="text-red-400 text-[11px] mt-2 text-center">
            Could not save this photo. Try another one.
          </p>
        )}
      </div>

      {/* API Test */}
      <div className="bg-[#111118] rounded-2xl p-4 mb-3 border border-white/[0.06]">
        <div className="flex items-center justify-between mb-3">
          <p className="text-gray-500 text-[10px] font-semibold uppercase tracking-[0.12em]">
            Local Server Test
          </p>
          {testStatus !== "idle" && (
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
              testStatus === "running" ? "bg-yellow-500/15 text-yellow-400" :
              testStatus === "success" ? "bg-emerald-500/15 text-emerald-400" :
                                         "bg-red-500/15 text-red-400"
            }`}>
              {testStatus === "running" ? "Running…" : testStatus === "success" ? "Passed" : "Failed"}
            </span>
          )}
        </div>

        <button onClick={handleTestApi} disabled={testStatus === "running"}
          className={`w-full py-2.5 rounded-xl text-[13px] font-medium transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed ${
            testStatus === "success" ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25" :
            testStatus === "error"   ? "bg-red-500/15 text-red-400 border border-red-500/25" :
                                       "bg-white/[0.05] hover:bg-white/[0.09] text-gray-300 border border-white/[0.06]"
          }`}>
          {testStatus === "running" ? "Testing…" : "Test Local Server"}
        </button>

        {testLog.length > 0 && (
          <div className="mt-3 bg-black/40 rounded-xl p-3 max-h-[150px] overflow-y-auto">
            {testLog.map((line, i) => (
              <p key={i} className={`text-[10px] font-mono leading-relaxed break-all ${
                line.startsWith("✓") ? "text-emerald-400" :
                line.startsWith("✗") ? "text-red-400" :
                line.startsWith("→") || line.startsWith("←") ? "text-violet-400" :
                "text-gray-500"
              }`}>{line}</p>
            ))}
            <div ref={logEndRef} />
          </div>
        )}

        {testStatus === "success" && testResultUrl && (
          <div className="mt-3">
            <img src={testResultUrl} alt="Test result"
              className="w-full h-[90px] object-cover rounded-xl" />
            <a href={testResultUrl} target="_blank" rel="noreferrer"
              className="mt-1.5 w-full flex items-center justify-center gap-1 text-[11px] text-violet-400 hover:text-violet-300 transition-colors">
              Open full result ↗
            </a>
          </div>
        )}
      </div>

      {/* Enable Replace */}
      <div className="bg-[#111118] rounded-2xl p-4 mb-3 border border-white/[0.06]">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-white text-[13px] font-medium leading-tight">Enable Replace</p>
            <p className={`text-[11px] mt-1 transition-colors ${isEnabled ? "text-violet-400" : "text-gray-600"}`}>
              {isEnabled ? "Extension active" : "Inactive"}
            </p>
          </div>
          <button onClick={handleToggleEnable} aria-label="Toggle enable"
            className={`relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${
              isEnabled ? "bg-violet-600" : "bg-white/10"
            }`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform duration-200 ${
              isEnabled ? "translate-x-5" : "translate-x-0"
            }`} />
          </button>
        </div>
      </div>

      {/* Select Image Mode */}
      <div className={`bg-[#111118] rounded-2xl p-4 border transition-opacity duration-200 ${
        isEnabled ? "border-white/[0.06] opacity-100" : "border-white/[0.03] opacity-40"
      }`}>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-white text-[13px] font-medium leading-tight">Select Image</p>
              {isSelectMode && (
                <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400 uppercase tracking-wider">
                  Active
                </span>
              )}
            </div>
            <p className={`text-[11px] mt-1 transition-colors ${
              isSelectMode ? "text-violet-400" : "text-gray-600"
            }`}>
              {isSelectMode
                ? "Click any image on the page"
                : isEnabled ? "Hover & click to swap a face" : "Enable Replace first"}
            </p>
          </div>

          <button onClick={handleToggleSelect} disabled={!isEnabled}
            aria-label="Toggle select mode"
            className={`relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none disabled:cursor-not-allowed ${
              isSelectMode ? "bg-violet-600" : "bg-white/10"
            }`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform duration-200 ${
              isSelectMode ? "translate-x-5" : "translate-x-0"
            }`} />
          </button>
        </div>

        {isSelectMode && (
          <p className="text-gray-600 text-[10px] mt-3 text-center">
            Press <span className="text-gray-400 font-mono bg-white/[0.06] px-1.5 py-0.5 rounded">ESC</span> on the page to cancel
          </p>
        )}
      </div>

      <p className="text-center text-gray-700 text-[10px] mt-4">
        v0.0.1 · AI Face Swap
      </p>
    </div>
  )
}

export default IndexPopup
