#!/usr/bin/env node
/**
 * Obtain and verify the pinned Microsoft-signed x64 Visual C++ 2015-2022 Redistributable
 * (`build/vc_redist.x64.exe`) required before running `npm run build:installer` on a clean checkout.
 *
 * Usage:
 *   node scripts/fetch-vcredist-x64.mjs
 *   node scripts/fetch-vcredist-x64.mjs --verify-only
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const rootDir = resolve(__dirname, '..')
const targetPath = join(rootDir, 'build', 'vc_redist.x64.exe')

export const PINNED_VCREDIST = {
  version: '14.44.35211.0',
  url: 'https://download.visualstudio.microsoft.com/download/pr/e9604e21-4b79-4096-a4b3-1b63d4b55b4d/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe',
  sha256: 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b',
  expectedSubject: 'CN=Microsoft Corporation'
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').toLowerCase()
}

function verifyAuthenticodeSignature(filePath) {
  if (process.platform !== 'win32') {
    return { skipped: true, reason: 'Authenticode check is Windows-only' }
  }
  const escaped = filePath.replace(/'/g, "''")
  const psScript = [
    `$sig = Get-AuthenticodeSignature -FilePath '${escaped}';`,
    `$subj = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' };`,
    `Write-Output "$($sig.Status)|$subj"`
  ].join(' ')
  const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', psScript], {
    stdio: 'pipe',
    encoding: 'utf8'
  })
  if (res.status !== 0) {
    throw new Error(`Authenticode check failed: ${res.stderr || res.stdout}`)
  }
  const [status = '', subject = ''] = res.stdout.trim().split('|')
  if (status !== 'Valid') {
    throw new Error(`Invalid Authenticode signature status: ${status}`)
  }
  if (!subject.includes(PINNED_VCREDIST.expectedSubject)) {
    throw new Error(`Unexpected Authenticode signer subject: ${subject}`)
  }
  return { skipped: false, status, subject }
}

function verifyFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${filePath}`)
  }
  const actualSha256 = sha256File(filePath)
  if (actualSha256 !== PINNED_VCREDIST.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${filePath}: expected ${PINNED_VCREDIST.sha256}, got ${actualSha256}`
    )
  }
  const sig = verifyAuthenticodeSignature(filePath)
  return { actualSha256, sig }
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status} ${res.statusText}) from ${url}`)
  }
  const outStream = createWriteStream(destPath)
  await pipeline(Readable.fromWeb(res.body), outStream)
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const verifyOnly = args.has('--verify-only')
  const force = args.has('--force')
  const url = process.env.PV_VCREDIST_URL || PINNED_VCREDIST.url

  if (verifyOnly) {
    const result = verifyFile(targetPath)
    console.log(
      `[OK] Verified ${targetPath} (SHA-256=${result.actualSha256}, sig=${result.sig.skipped ? 'skipped' : result.sig.status})`
    )
    return
  }

  if (!force && existsSync(targetPath)) {
    try {
      const result = verifyFile(targetPath)
      console.log(
        `[OK] Existing ${targetPath} matches pinned SHA-256 ${result.actualSha256} and Microsoft signature.`
      )
      return
    } catch (err) {
      console.warn(
        `[WARN] Existing ${targetPath} failed verification (${err.message}); re-downloading...`
      )
    }
  }

  mkdirSync(join(rootDir, 'build'), { recursive: true })
  const tmpPath = `${targetPath}.tmp`
  rmSync(tmpPath, { force: true })

  console.log(`Downloading ${url} ...`)
  try {
    await downloadFile(url, tmpPath)
    const result = verifyFile(tmpPath)
    renameSync(tmpPath, targetPath)
    console.log(
      `[OK] Staged ${targetPath} (version=${PINNED_VCREDIST.version}, SHA-256=${result.actualSha256}, sig=${result.sig.skipped ? 'skipped' : result.sig.status})`
    )
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
}

main().catch((err) => {
  console.error(`[ERROR] ${err.message}`)
  process.exitCode = 1
})
