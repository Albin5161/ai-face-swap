require("dotenv").config()
const express = require("express")
const cors    = require("cors")
const { execFile } = require("child_process")
const fs   = require("fs")
const path = require("path")
const os   = require("os")
const { v4: uuidv4 } = require("uuid")

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT           = process.env.PORT           || 3000
const FACEFUSION_DIR = process.env.FACEFUSION_DIR || path.join(os.homedir(), "facefusion")
const PYTHON         = process.env.PYTHON         || "python3"

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express()

app.use(cors({ origin: "*" }))
app.use(express.json({ limit: "20mb" }))

// ─── /health ──────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  const scriptPath = path.join(FACEFUSION_DIR, "facefusion.py")
  const exists = fs.existsSync(scriptPath)
  if (!exists) {
    return res.status(503).json({
      ok: false,
      error: `FaceFusion not found at ${scriptPath}. Set FACEFUSION_DIR env var.`
    })
  }
  res.json({ ok: true, facefusionDir: FACEFUSION_DIR, python: PYTHON })
})

// ─── Face check ───────────────────────────────────────────────────────────────

// Resolves to the number of faces in each image, or null if the check itself
// could not run (the swap then goes ahead without it).
function countFaces(imagePaths) {
  return new Promise((resolve) => {
    execFile(PYTHON, [path.join(__dirname, "count_faces.py"), ...imagePaths], {
      cwd: FACEFUSION_DIR,
      timeout: 60_000
    }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[AIR] face check failed — skipping: ${stderr.slice(-300)}`)
        return resolve(null)
      }
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop()))
      } catch {
        console.error("[AIR] face check gave unreadable output — skipping")
        resolve(null)
      }
    })
  })
}

// ─── /faceswap ────────────────────────────────────────────────────────────────

// Body:
//   targetUrl     — HTTP(S) URL of ecommerce image  OR  a data: URL (for self-tests)
//   sourceDataUrl — data:image/...;base64,... of the user's face

app.post("/faceswap", async (req, res) => {
  const { targetUrl, sourceDataUrl } = req.body

  if (!targetUrl || !sourceDataUrl) {
    return res.status(400).json({ success: false, error: "targetUrl and sourceDataUrl are required" })
  }

  const id      = uuidv4()
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), `air_${id}_`))
  const srcPath = path.join(tmpDir, "source.jpg")
  const tgtPath = path.join(tmpDir, "target.jpg")
  const outPath = path.join(tmpDir, "output.jpg")

  console.log(`\n[AIR] ── New request ${id} ──────────────────────────`)
  console.log(`[AIR] tmpDir    : ${tmpDir}`)
  console.log(`[AIR] srcPath   : ${srcPath}`)
  console.log(`[AIR] tgtPath   : ${tgtPath}`)
  console.log(`[AIR] outPath   : ${outPath}`)
  console.log(`[AIR] targetUrl : ${targetUrl.slice(0, 80)}${targetUrl.length > 80 ? "…" : ""}`)
  console.log(`[AIR] sourceDataUrl length: ${sourceDataUrl.length}`)

  try {
    // 1. Save source face (data URL → file)
    console.log("[AIR] Step 1: saving source face…")
    const b64 = sourceDataUrl.split(",")[1]
    if (!b64) throw new Error("Invalid sourceDataUrl — expected data:image/...;base64,...")
    fs.writeFileSync(srcPath, Buffer.from(b64, "base64"))
    console.log(`[AIR] Source saved — ${fs.statSync(srcPath).size} bytes`)

    // 2. Download or decode target image
    console.log("[AIR] Step 2: obtaining target image…")
    if (targetUrl.startsWith("data:")) {
      // Self-test: target is also a data URL
      const tgtB64 = targetUrl.split(",")[1]
      if (!tgtB64) throw new Error("Invalid targetUrl data URI")
      fs.writeFileSync(tgtPath, Buffer.from(tgtB64, "base64"))
      console.log(`[AIR] Target from data URL — ${fs.statSync(tgtPath).size} bytes`)
    } else {
      console.log(`[AIR] Fetching: ${targetUrl}`)
      let tgtRes
      try {
        tgtRes = await fetch(targetUrl)
      } catch (fetchErr) {
        throw new Error(`fetch failed for target URL: ${fetchErr.message}`)
      }
      if (!tgtRes.ok) throw new Error(`Target fetch HTTP error: ${tgtRes.status} ${tgtRes.statusText}`)
      const tgtBuf = Buffer.from(await tgtRes.arrayBuffer())
      fs.writeFileSync(tgtPath, tgtBuf)
      console.log(`[AIR] Target saved — ${tgtBuf.length} bytes`)
    }

    // 3. Check both images have a face — FaceFusion returns the target untouched when it finds none
    console.log("[AIR] Step 3: checking for faces…")
    const faceCounts = await countFaces([srcPath, tgtPath])
    if (faceCounts) {
      console.log(`[AIR] Faces — source: ${faceCounts[0]}, target: ${faceCounts[1]}`)
      if (faceCounts[0] === 0) {
        return res.status(422).json({ success: false, error: "No face found in your photo. Upload a clear, front-facing photo." })
      }
      if (faceCounts[1] === 0) {
        return res.status(422).json({ success: false, error: "No face found in this picture, so there is nothing to swap." })
      }
    }

    // 4. Run FaceFusion
    const scriptPath = path.join(FACEFUSION_DIR, "facefusion.py")
    // Correct short flags for this version: -s / -t / -o
    const args = [
      scriptPath, "headless-run",
      "-s", srcPath,
      "-t", tgtPath,
      "-o", outPath,
      "--processors", "face_swapper",
      "--face-swapper-model", "inswapper_128_fp16"
    ]

    const fullCmd = `${PYTHON} ${args.join(" ")}`
    console.log(`[AIR] Step 4: executing FaceFusion…`)
    console.log(`[AIR] CMD: ${fullCmd}`)

    await new Promise((resolve, reject) => {
      execFile(PYTHON, args, {
        cwd: FACEFUSION_DIR,
        timeout: 120_000,
        env: { ...process.env, PYTHONUNBUFFERED: "1" }
      }, (err, stdout, stderr) => {
        if (stdout && stdout.trim()) {
          console.log("[FF stdout]", stdout.trim())
        }
        if (stderr && stderr.trim()) {
          console.error("[FF stderr]", stderr.trim())
        }
        if (err) {
          console.error(`[AIR] execFile error — code=${err.code} signal=${err.signal}`)
          console.error(`[AIR] Last stderr: ${stderr.slice(-500)}`)
          return reject(new Error(`FaceFusion failed (exit ${err.code}): ${stderr.slice(-300)}`))
        }
        console.log("[AIR] FaceFusion process exited cleanly")
        resolve()
      })
    })

    // 5. Read output
    console.log(`[AIR] Step 5: reading output file…`)
    if (!fs.existsSync(outPath)) {
      throw new Error("FaceFusion finished but produced no output image.")
    }
    const outBuf  = fs.readFileSync(outPath)
    const dataUrl = `data:image/jpeg;base64,${outBuf.toString("base64")}`
    console.log(`[AIR] Success — output ${outBuf.length} bytes`)

    res.json({ success: true, dataUrl })

  } catch (err) {
    console.error(`[AIR] /faceswap FAILED: ${err.message}`)
    res.status(500).json({ success: false, error: err.message })

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[AIR] Local server running on http://localhost:${PORT}`)
  console.log(`[AIR] FaceFusion directory: ${FACEFUSION_DIR}`)
  console.log(`[AIR] Python interpreter:   ${PYTHON}`)
})
