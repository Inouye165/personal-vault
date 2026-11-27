#!/usr/bin/env node
/**
 * Real-Electron end-to-end verification for Stage 8B Slice 2:
 * - Populates an isolated fixture with an imported photo and document in a surviving vault.
 * - Deletes the original source folder so original source paths are unavailable.
 * - Recovers the catalog into a fresh isolated profile through the Backup & Restore UI.
 * - Launches Electron against the recovered profile and verifies:
 *   1. Photo renders in Photos (thumbnail status ready + <img> loaded).
 *   2. Document text extraction & preview returns the expected contents.
 *   3. Imports into the read-only bound vault are refused.
 *   4. Surviving vault files (vault.json, manifests, payloads) have unchanged SHA-256 & mtime.
 *
 * Usage: node scripts/verify-electron-catalog-recovery.mjs [--mode=built|unpacked]
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import sharp from 'sharp'

const root = resolve(import.meta.dirname, '..')
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  })
)
const mode = args.mode || 'built'
if (!['built', 'unpacked'].includes(mode)) {
  console.error('Usage: node scripts/verify-electron-catalog-recovery.mjs [--mode=built|unpacked]')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function snapshotTree(dir) {
  const out = new Map()
  const walk = (cur) => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        const st = statSync(full)
        out.set(full.slice(dir.length + 1).replace(/\\/g, '/'), {
          sha256: sha256File(full),
          size: st.size,
          mtimeMs: st.mtimeMs
        })
      }
    }
  }
  walk(dir)
  return out
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

function getLaunchSpec(port, userDataDir) {
  const common = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`]
  if (mode === 'built') {
    if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
      throw new Error('out/ is missing. Run `npm run build` first.')
    }
    return { command: electronPath, argv: ['.', ...common] }
  }
  const unpackedDir = process.env.PV_UNPACKED_DIR || join(root, 'dist', 'win-unpacked')
  const exe = join(unpackedDir, 'Personal Vault.exe')
  if (!existsSync(exe)) {
    throw new Error(`${exe} is missing. Run \`npm run build:unpack\` first.`)
  }
  return { command: exe, argv: common }
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
}

async function findPageTarget(port, deadline, child, getLogs) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Electron exited prematurely (exitCode=${child.exitCode}, signal=${child.signalCode}): ${getLogs()}`
      )
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools:'))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // retry
    }
    await sleep(150)
  }
  throw new Error(
    `Timed out waiting for Electron CDP target on port ${port} (exitCode=${child.exitCode}, signal=${child.signalCode}): ${getLogs()}`
  )
}

async function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', rejectOpen, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)))
      else res(msg.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = nextId++
      pending.set(id, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  return {
    async evalAsync(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (r.exceptionDetails) {
        throw new Error(
          r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Eval exception'
        )
      }
      return r.result?.value
    },
    close() {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  }
}

async function launchApp(userDataDir) {
  const port = await freePort()
  const spec = getLaunchSpec(port, userDataDir)
  const child = spawn(spec.command, spec.argv, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  })
  const logChunks = []
  const appendLog = (chunk) => {
    logChunks.push(chunk.toString('utf8'))
    if (logChunks.length > 40) logChunks.shift()
  }
  child.stdout?.on('data', appendLog)
  child.stderr?.on('data', appendLog)
  const getLogs = () => logChunks.join('').trim() || '(no stdout/stderr output)'

  const page = await findPageTarget(port, Date.now() + 30_000, child, getLogs)
  const cdp = await openCdp(page.webSocketDebuggerUrl)
  await cdp.evalAsync(`(async () => {
    for (let i = 0; i < 60; i++) {
      if (window.api && document.querySelector('#main-sidebar')) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('App UI did not mount');
  })()`)
  return {
    child,
    cdp,
    async shutdown() {
      cdp.close()
      killTree(child)
      await sleep(500)
    }
  }
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), `pv-verify-recovery-${mode}-`))
  const sourceDir = join(workDir, 'originals')
  const activeProfileDir = join(workDir, 'active-profile')
  const survivingVaultDir = join(workDir, 'surviving-vault')
  const recoveredProfileDir = join(workDir, 'recovered-profile')

  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(activeProfileDir, { recursive: true })
  mkdirSync(survivingVaultDir, { recursive: true })

  const expectedDocText = 'Recovered vault document preview text — Stage 8B Slice 2.'
  const jpegBytes = await sharp({
    create: { width: 48, height: 48, channels: 3, background: { r: 30, g: 140, b: 220 } }
  })
    .jpeg()
    .toBuffer()
  writeFileSync(join(sourceDir, 'trip-photo.jpg'), jpegBytes)
  writeFileSync(join(sourceDir, 'ledger-note.txt'), expectedDocText, 'utf8')

  let app1 = null
  let app2 = null
  try {
    console.log(
      `[verify:recovery:${mode}] Phase 1: Launch active profile, scan & import into vault`
    )
    app1 = await launchApp(activeProfileDir)
    const vaultId = await app1.cdp.evalAsync(`(async () => {
      const scanJob = await window.api.startScan({ roots: [${JSON.stringify(sourceDir)}] });
      for (let i = 0; i < 120; i++) {
        const cur = await window.api.getActiveScanJob();
        if (!cur || cur.status === 'completed' || cur.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const vaultRes = await window.api.initializeVault({
        vaultPath: ${JSON.stringify(survivingVaultDir)},
        vaultName: 'Surviving Test Vault'
      });
      const cands = await window.api.getImportCandidates({
        vaultId: vaultRes.vault.vaultId,
        offset: 0,
        limit: 50
      });
      if (cands.items.length !== 2) {
        throw new Error('Expected 2 import candidates, got ' + cands.items.length);
      }
      await window.api.startImport({
        vaultId: vaultRes.vault.vaultId,
        fileLocationIds: cands.items.map((x) => x.fileLocationId)
      });
      for (let i = 0; i < 120; i++) {
        const res = await window.api.getActiveImportJob();
        const job = res?.job ?? null;
        if (!job || job.status === 'completed' || job.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return vaultRes.vault.vaultId;
    })()`)
    console.log(`[verify:recovery:${mode}] [PASS] Phase 1: Vault populated (${vaultId})`)

    // Snapshot surviving vault hashes before deleting originals and recovering
    const vaultSnapshotBefore = snapshotTree(survivingVaultDir)
    if (vaultSnapshotBefore.size < 5) {
      throw new Error(`Expected >= 5 files in surviving vault, got ${vaultSnapshotBefore.size}`)
    }

    console.log(`[verify:recovery:${mode}] Phase 2: Delete original source folder`)
    rmSync(sourceDir, { recursive: true, force: true })
    if (existsSync(sourceDir)) {
      throw new Error('Original source directory still exists')
    }
    console.log(`[verify:recovery:${mode}] [PASS] Phase 2: Originals unavailable on disk`)

    console.log(`[verify:recovery:${mode}] Phase 3: Recover catalog through Backup & Restore UI`)
    const uiRecoveryText = await app1.cdp.evalAsync(`(async () => {
      const navButtons = Array.from(document.querySelectorAll('#main-sidebar button'));
      const backupBtn = navButtons.find((b) => /Backup/i.test(b.textContent || ''));
      if (!backupBtn) throw new Error('Backup & Restore nav button not found');
      backupBtn.click();

      let section = null;
      for (let i = 0; i < 40; i++) {
        section = document.querySelector('[data-testid="recover-from-vault-section"]');
        if (section) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!section) throw new Error('Recover from an existing vault section not found');

      const setReactInput = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };

      const vaultInput = document.querySelector('[data-testid="recover-vault-dir-input"]');
      const profileInput = document.querySelector('[data-testid="recover-profile-dir-input"]');
      setReactInput(vaultInput, ${JSON.stringify(survivingVaultDir)});
      setReactInput(profileInput, ${JSON.stringify(recoveredProfileDir)});
      await new Promise((r) => setTimeout(r, 50));

      const submitBtn = document.querySelector('[data-testid="recover-catalog-submit-btn"]');
      if (!submitBtn || submitBtn.disabled) throw new Error('Recover submit button disabled');
      submitBtn.click();

      let resultBox = null;
      for (let i = 0; i < 120; i++) {
        resultBox = document.querySelector('[data-testid="recover-catalog-result"]');
        if (resultBox) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!resultBox) {
        const alert = document.querySelector('[role="alert"]');
        throw new Error('Recovery result not rendered: ' + (alert?.textContent || 'no alert'));
      }
      return resultBox.textContent || '';
    })()`)
    if (!/2 verified vault copies/i.test(uiRecoveryText)) {
      throw new Error(`Unexpected UI recovery result: ${uiRecoveryText}`)
    }
    console.log(`[verify:recovery:${mode}] [PASS] Phase 3: UI recovery succeeded`)

    await app1.shutdown()
    app1 = null

    console.log(
      `[verify:recovery:${mode}] Phase 4: Launch recovered profile, verify photo, document & read-only refusal`
    )
    app2 = await launchApp(recoveredProfileDir)
    const phase4 = await app2.cdp.evalAsync(`(async () => {
      const photosPage = await window.api.getPhotosPage({ offset: 0, limit: 20 });
      if (photosPage.items.length !== 1) {
        throw new Error('Expected 1 recovered photo, got ' + photosPage.items.length);
      }
      const photo = photosPage.items[0];
      const thumb = await window.api.getThumbnail({ locationId: photo.id, priority: 'high' });
      if (thumb.status !== 'ready') {
        throw new Error('Expected photo thumbnail ready, got ' + JSON.stringify(thumb));
      }

      // Verify Photos tab renders the image in DOM
      const navButtons = Array.from(document.querySelectorAll('#main-sidebar button'));
      const photosNav = navButtons.find((b) => /^Photos$/i.test((b.textContent || '').trim()));
      if (photosNav) photosNav.click();
      let imgLoaded = false;
      for (let i = 0; i < 60; i++) {
        const img = document.querySelector('img[src^="data:image/"]');
        if (img && img.complete && img.naturalWidth > 0) {
          imgLoaded = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!imgLoaded) throw new Error('Recovered photo <img> did not render in Photos tab');

      // Extract and inspect recovered document preview
      const docsPage = await window.api.getDocumentsPage({ offset: 0, limit: 20 });
      if (docsPage.items.length !== 1) {
        throw new Error('Expected 1 recovered document, got ' + docsPage.items.length);
      }
      const doc = docsPage.items[0];
      await window.api.startDocumentExtraction({ scope: 'all' });
      for (let i = 0; i < 120; i++) {
        const p = await window.api.getDocumentExtractionProgress();
        if (p.status === 'completed' || p.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const previewRes = await window.api.getDocumentPreview({ fileLocationId: doc.fileLocationId });
      const preview = previewRes?.preview ?? previewRes;
      if (!preview || !preview.extractedText || !preview.extractedText.includes(${JSON.stringify(expectedDocText)})) {
        throw new Error('Unexpected document preview: ' + JSON.stringify(previewRes));
      }

      // Confirm imports into read-only vault are refused
      const activeVault = await window.api.getActiveVault();
      let importRefusedError = null;
      try {
        await window.api.startImport({
          vaultId: activeVault.vault.vaultId,
          fileLocationIds: [photo.id]
        });
      } catch (err) {
        importRefusedError = err instanceof Error ? err.message : String(err);
      }
      if (!importRefusedError || !/read-only/i.test(importRefusedError)) {
        throw new Error('Expected read-only vault import refusal, got: ' + importRefusedError);
      }

      return {
        photoThumbStatus: thumb.status,
        imgLoaded,
        docPreviewText: preview.extractedText,
        importRefusedError
      };
    })()`)
    console.log(`[verify:recovery:${mode}] [PASS] Phase 4:`, JSON.stringify(phase4))

    await app2.shutdown()
    app2 = null

    console.log(`[verify:recovery:${mode}] Phase 5: Verify surviving vault bitwise invariance`)
    const vaultSnapshotAfter = snapshotTree(survivingVaultDir)
    if (vaultSnapshotAfter.size !== vaultSnapshotBefore.size) {
      throw new Error(
        `Surviving vault file count changed: before=${vaultSnapshotBefore.size}, after=${vaultSnapshotAfter.size}`
      )
    }
    for (const [rel, before] of vaultSnapshotBefore.entries()) {
      const after = vaultSnapshotAfter.get(rel)
      if (
        !after ||
        after.sha256 !== before.sha256 ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      ) {
        throw new Error(`Surviving vault file changed: ${rel}`)
      }
    }
    console.log(
      `[verify:recovery:${mode}] [PASS] Phase 5: Surviving vault 100% bitwise unchanged (${vaultSnapshotAfter.size} files)`
    )
    console.log(`[verify:recovery:${mode}] PASSED`)
  } finally {
    if (app1) await app1.shutdown()
    if (app2) await app2.shutdown()
    try {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Ignore transient Windows handle release delay on temp cleanup
    }
  }
}

main().catch((err) => {
  console.error(`[verify:recovery:${mode}] FAILED:`, err)
  process.exit(1)
})
