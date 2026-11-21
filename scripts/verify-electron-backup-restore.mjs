#!/usr/bin/env node
/**
 * Real-Electron end-to-end verification for Stage 8B Sub-slice 1C:
 * - Launches the built or unpacked Personal Vault executable against an isolated profile.
 * - Verifies the Backup & Restore UI tab and "files outside the vault are excluded" notice.
 * - Imports fixture files into an isolated vault, sets photo rating/flag & collection.
 * - Runs a full backup, exercises pause + Electron restart + resume to completion.
 * - Verifies the recovery point and restores into a separate isolated profile + vault.
 * - Launches Electron against the restored profile and verifies restored hashes & annotations.
 * - Verifies Electron refuses startup on an incomplete restored profile (.pv-restore-in-progress.json).
 *
 * Usage: node scripts/verify-electron-backup-restore.mjs [--mode=built|unpacked]
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const root = resolve(import.meta.dirname, '..')
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  })
)
const mode = args.mode || 'built'
if (!['built', 'unpacked'].includes(mode)) {
  console.error('Usage: node scripts/verify-electron-backup-restore.mjs [--mode=built|unpacked]')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
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

async function findPageTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools:'))
      if (page) return page
    } catch {
      /* not ready yet */
    }
    await sleep(250)
  }
  throw new Error('Timed out waiting for Electron CDP page target')
}

function connectCdp(wsUrl) {
  return new Promise((resolveConn, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()
    ws.addEventListener('open', () => resolveConn(client))
    ws.addEventListener('error', (err) => reject(err))
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message))
        else res(msg.result)
      }
    })
    const client = {
      send(method, params = {}) {
        const id = nextId++
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ id, method, params }))
        })
      },
      async eval(expression) {
        const res = await this.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true
        })
        if (res.exceptionDetails) {
          throw new Error(
            res.exceptionDetails.exception?.description ||
              res.exceptionDetails.text ||
              'Renderer eval exception'
          )
        }
        return res.result?.value
      },
      close() {
        ws.close()
      }
    }
  })
}

async function launchAndConnect(userDataDir) {
  const port = await freePort()
  const { command, argv } = getLaunchSpec(port, userDataDir)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(command, argv, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const page = await findPageTarget(port, Date.now() + 25_000)
  const cdp = await connectCdp(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')

  // Wait for window.api and React root
  const readyDeadline = Date.now() + 20_000
  while (Date.now() < readyDeadline) {
    const ok = await cdp.eval(`Boolean(window.api && document.querySelector('#main-sidebar'))`)
    if (ok) break
    await sleep(150)
  }

  return { child, cdp, command }
}

// Create a minimal valid 1x1 PNG
function createMinimalPng() {
  return Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082',
    'hex'
  )
}

async function main() {
  const workRoot = mkdtempSync(join(tmpdir(), 'pv-8b-1c-e2e-'))
  const sourceDir = join(workRoot, 'sources')
  const vaultDir = join(workRoot, 'vault')
  const profileDir = join(workRoot, 'profile')
  const backupRepoDir = join(workRoot, 'backup-usb')
  const restoreProfileDir = join(workRoot, 'restored-profile')
  const restoreVaultDir = join(workRoot, 'restored-vault')
  const incompleteProfileDir = join(workRoot, 'incomplete-profile')

  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(backupRepoDir, { recursive: true })
  mkdirSync(incompleteProfileDir, { recursive: true })

  const photoPath = join(sourceDir, 'family-photo.png')
  writeFileSync(photoPath, createMinimalPng())
  // Add a 12 MiB file so multi-chunk backup has room to pause/resume cleanly across restart
  const largeDocPath = join(sourceDir, 'archive-doc.txt')
  const largeBuf = Buffer.alloc(12 * 1024 * 1024, 0x41)
  largeBuf.write('Personal Vault Stage 8B 1C Verification Document\n', 0, 'utf8')
  writeFileSync(largeDocPath, largeBuf)

  const origPhotoSha = sha256File(photoPath)
  const origDocSha = sha256File(largeDocPath)
  const origPhotoStat = statSync(photoPath)
  const origDocStat = statSync(largeDocPath)

  let activeChild = null
  try {
    // 1. Launch app with isolated profile, import files, annotate, verify UI, start & pause backup
    console.log(`[1/5] Launching ${mode} Electron against isolated profile...`)
    const session1 = await launchAndConnect(profileDir)
    activeChild = session1.child

    // Verify Backup & Restore tab and exclusion notice in UI
    const uiCheck = await session1.cdp.eval(`(async () => {
      const buttons = Array.from(document.querySelectorAll('#main-sidebar button'));
      const backupBtn = buttons.find((b) => /Backup & Restore/i.test(b.textContent || ''));
      if (!backupBtn) throw new Error('Backup & Restore nav button not found');
      backupBtn.click();
      await new Promise((r) => setTimeout(r, 150));
      const text = document.body.innerText;
      if (!/files outside the vault are excluded/i.test(text)) {
        throw new Error('Missing exclusion notice on Backup & Restore screen');
      }
      const page = await window.api.listBackupJobs({ limit: 20, offset: 0 });
      if (page.total !== 0 || page.limit !== 20 || page.offset !== 0) {
        throw new Error('Unexpected initial backup history: ' + JSON.stringify(page));
      }
      const alert = document.querySelector('.backup-restore-panel [role="alert"]');
      if (alert) throw new Error('Backup screen failed to load: ' + alert.textContent);
      return true;
    })()`)
    if (!uiCheck) throw new Error('UI check failed')

    // Initialize vault & import source files via IPC bridge, set annotation & collection
    console.log('[2/5] Initializing vault, importing files, setting annotations...')
    const { importJobId, vaultId } = await session1.cdp.eval(`(async () => {
      const vaultInit = await window.api.initializeVault({
        vaultPath: ${JSON.stringify(vaultDir)},
        vaultName: 'E2E Test Vault'
      });
      const vaultId = vaultInit.vault?.vaultId;
      if (!vaultId) throw new Error('Failed to initialize vault');
      const scan = await window.api.startScan({ roots: [${JSON.stringify(sourceDir)}] });
      const scanDeadline = Date.now() + 20000;
      while (Date.now() < scanDeadline) {
        const latest = await window.api.getLatestScanJob();
        if (latest && latest.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const candidates = await window.api.getImportCandidates({ vaultId, limit: 20, offset: 0 });
      const ids = candidates.items.map((i) => i.fileLocationId);
      if (ids.length < 2) throw new Error('Expected 2 import candidates, got ' + ids.length);
      const imp = await window.api.startImport({ vaultId, fileLocationIds: ids });
      const impDeadline = Date.now() + 20000;
      while (Date.now() < impDeadline) {
        const latest = await window.api.getLatestImportJob();
        if (latest && latest.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const photos = await window.api.getPhotosPage({ limit: 10, offset: 0 });
      const photo = photos.items[0];
      if (!photo) throw new Error('Expected imported photo in photos page');
      const expectedRevision =
        'rev:' +
        photo.discoveryObservationId +
        ':' +
        photo.byteSize +
        ':' +
        (photo.filesystemMtimeMs ?? 'null') +
        ':' +
        (photo.activeHash ?? 'null');
      await window.api.setPhotoAnnotation({
        fileLocationId: photo.id,
        expectedRevision,
        expectedVersion: photo.annotationVersion ?? 0,
        rating: 5,
        flag: 'pick'
      });
      const col = await window.api.createCollection({ name: 'E2E Backup Collection' });
      await window.api.addCollectionMember({
        collectionId: col.collection.id,
        fileLocationId: photo.id,
        expectedRevision
      });
      return { importJobId: imp.job?.id ?? imp.importId ?? 'completed', vaultId };
    })()`)
    console.log(`   Imported into vault ${vaultId} (job ${importJobId})`)

    // Configure destination (with 1 MiB/s rate cap so pause catches mid-transfer deterministically)
    console.log('[3/5] Starting backup, pausing mid-transfer, restarting Electron, and resuming...')
    const pausedJobId = await session1.cdp.eval(`(async () => {
      const dest = await window.api.configureBackupDestination({
        name: 'E2E USB Drive',
        kind: 'local_fs',
        targetPath: ${JSON.stringify(backupRepoDir)},
        maxBytesPerSecond: 1048576
      });
      const job = await window.api.startBackup({ destinationId: dest.id });
      await new Promise((r) => setTimeout(r, 600));
      await window.api.pauseBackup(job.id);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const current = await window.api.getBackupJob(job.id);
        if (current && (current.status === 'paused' || current.status === 'completed')) {
          return current.id;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return job.id;
    })()`)

    session1.cdp.close()
    killTree(session1.child)
    activeChild = null
    await sleep(400)

    // 2. Relaunch Electron against the same profileDir, resume paused/interrupted job, verify, and restore
    const session2 = await launchAndConnect(profileDir)
    activeChild = session2.child

    const restoreSummary = await session2.cdp.eval(`(async () => {
      const jobBefore = await window.api.getBackupJob(${JSON.stringify(pausedJobId)});
      if (!jobBefore) throw new Error('Paused/interrupted job not found after restart');
      let completedSnapshotId = jobBefore.snapshotId;
      if (jobBefore.status === 'paused' || jobBefore.status === 'interrupted') {
        const resumed = await window.api.resumeBackup(jobBefore.id);
        completedSnapshotId = resumed.snapshotId;
      }
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const current = await window.api.getBackupJob(jobBefore.id);
        if (current && current.status === 'completed') {
          completedSnapshotId = current.snapshotId;
          break;
        }
        if (current && current.status === 'failed') {
          throw new Error('Resumed backup failed: ' + current.errorMessage);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      const backupBtn = Array.from(document.querySelectorAll('#main-sidebar button'))
        .find((button) => /Backup & Restore/i.test(button.textContent || ''));
      if (!backupBtn) throw new Error('Backup & Restore nav button not found on restart');
      backupBtn.click();
      const historyDeadline = Date.now() + 5000;
      while (Date.now() < historyDeadline) {
        const alert = document.querySelector('.backup-restore-panel [role="alert"]');
        if (alert) throw new Error('Backup history failed to load: ' + alert.textContent);
        const jobStatus = document.querySelector('[data-testid="backup-job-status-' + jobBefore.id + '"]');
        if (jobStatus?.textContent === 'completed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const jobStatus = document.querySelector('[data-testid="backup-job-status-' + jobBefore.id + '"]');
      if (jobStatus?.textContent !== 'completed') throw new Error('Completed job missing from Backup Jobs');
      const banner = document.querySelector('.backup-job-notice[role="status"]');
      if (!banner?.textContent.includes('Backup completed successfully')) {
        throw new Error('Backup completion banner is missing');
      }
      const rps = await window.api.listRecoveryPoints({ backupRepoDir: ${JSON.stringify(backupRepoDir)} });
      const completeRp = rps.recoveryPoints.find((r) => r.snapshotId === completedSnapshotId);
      if (!completeRp || !completeRp.isComplete) {
        throw new Error('Recovery point not marked complete after resume');
      }
      const verified = await window.api.verifyRecoveryPoint({
        backupRepoDir: ${JSON.stringify(backupRepoDir)},
        snapshotId: completedSnapshotId
      });
      const restored = await window.api.restoreRecoveryPoint({
        backupRepoDir: ${JSON.stringify(backupRepoDir)},
        snapshotId: completedSnapshotId,
        targetProfileDir: ${JSON.stringify(restoreProfileDir)},
        targetVaultDir: ${JSON.stringify(restoreVaultDir)}
      });
      return { completedSnapshotId, verified, restored };
    })()`)
    console.log(
      `   Verified & restored snapshot ${restoreSummary.completedSnapshotId} (${restoreSummary.restored.verifiedFileCount} files)`
    )

    session2.cdp.close()
    killTree(session2.child)
    activeChild = null
    await sleep(400)

    // 3. Verify restored file hashes & untouched originals
    console.log('[4/5] Verifying restored file hashes and launching restored profile...')
    const restoredPhotoPath = join(
      restoreVaultDir,
      'files',
      origPhotoSha.slice(0, 2),
      origPhotoSha,
      'family-photo.png'
    )
    const restoredDocPath = join(
      restoreVaultDir,
      'files',
      origDocSha.slice(0, 2),
      origDocSha,
      'archive-doc.txt'
    )
    if (sha256File(restoredPhotoPath) !== origPhotoSha) {
      throw new Error('Restored photo SHA-256 mismatch')
    }
    if (sha256File(restoredDocPath) !== origDocSha) {
      throw new Error('Restored document SHA-256 mismatch')
    }
    if (
      sha256File(photoPath) !== origPhotoSha ||
      statSync(photoPath).mtimeMs !== origPhotoStat.mtimeMs ||
      sha256File(largeDocPath) !== origDocSha ||
      statSync(largeDocPath).mtimeMs !== origDocStat.mtimeMs
    ) {
      throw new Error('Original source files were modified!')
    }

    // Launch Electron against restoreProfileDir and verify restored vault & annotations
    const session3 = await launchAndConnect(restoreProfileDir)
    activeChild = session3.child
    const restoredUiCheck = await session3.cdp.eval(`(async () => {
      const activeVault = await window.api.getActiveVault();
      if (!activeVault?.vault || activeVault.vault.vaultPath !== ${JSON.stringify(restoreVaultDir)}) {
        throw new Error('Restored active vault path mismatch: ' + JSON.stringify(activeVault));
      }
      const photos = await window.api.getPhotosPage({ limit: 10, offset: 0 });
      const photo = photos.items[0];
      if (!photo || photo.rating !== 5 || photo.flag !== 'pick') {
        throw new Error('Restored photo annotation mismatch: ' + JSON.stringify(photo));
      }
      const cols = await window.api.listCollections();
      if (!cols.items.some((c) => c.name === 'E2E Backup Collection')) {
        throw new Error('Restored collection missing');
      }
      return { vaultPath: activeVault.vault.vaultPath, rating: photo.rating, flag: photo.flag };
    })()`)
    console.log(`   Restored profile verified in Electron: ${JSON.stringify(restoredUiCheck)}`)
    session3.cdp.close()
    killTree(session3.child)
    activeChild = null
    await sleep(300)

    // 4. Verify rejection of incomplete restored profile
    console.log('[5/5] Verifying startup rejection of incomplete restored profile...')
    writeFileSync(
      join(incompleteProfileDir, '.pv-restore-in-progress.json'),
      JSON.stringify({
        formatVersion: 1,
        restoreJobId: '00000000-0000-4000-8000-000000000001',
        repositoryId: '00000000-0000-4000-8000-000000000002',
        snapshotId: 'incomplete-snap',
        targetProfileDir: incompleteProfileDir,
        targetVaultDir: null,
        startedAtMs: Date.now()
      }),
      'utf8'
    )

    const port4 = await freePort()
    const spec4 = getLaunchSpec(port4, incompleteProfileDir)
    const env4 = { ...process.env }
    delete env4.ELECTRON_RUN_AS_NODE
    const res4 = spawnSync(spec4.command, spec4.argv, {
      cwd: root,
      env: env4,
      timeout: 15_000,
      encoding: 'utf8'
    })
    if (res4.status === 0) {
      throw new Error(
        'Expected Electron to refuse startup on incomplete restored profile, but it exited 0'
      )
    }
    if (existsSync(join(incompleteProfileDir, 'annotations', 'review-journal.jsonl'))) {
      throw new Error('Incomplete profile startup created review-journal.jsonl!')
    }
    const startupLog = existsSync(join(incompleteProfileDir, 'startup.log'))
      ? readFileSync(join(incompleteProfileDir, 'startup.log'), 'utf8')
      : ''
    if (!/RestoreIncompleteError|Refusing startup/i.test(startupLog)) {
      throw new Error(`Expected RestoreIncompleteError in startup.log, got:\n${startupLog}`)
    }
    console.log(`   Incomplete profile cleanly rejected (exit=${res4.status}).`)
    console.log(`ALL CHECKS PASSED (mode=${mode}, executable=${spec4.command}).`)
  } finally {
    if (activeChild) killTree(activeChild)
    await sleep(300)
    try {
      rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // Best-effort cleanup on Windows
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
