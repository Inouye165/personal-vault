/**
 * Verifies a Personal Vault release bundle (latest.yml, SHA256SUMS.txt,
 * build-manifest.json, NSIS .exe, and .blockmap) fail-closed before promotion.
 *
 * Usage:
 *   node scripts/verify-release-bundle.mjs --bundle-dir=dist/rc [--expected-tag=v0.1.1]
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function stripQuotes(raw) {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function assertSafeSingleFileName(fileName, label) {
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new Error(`Unsafe ${label} filename: "${fileName}"`)
  }
  if (basename(fileName) !== fileName) {
    throw new Error(`Invalid ${label} path traversal: "${fileName}"`)
  }
}

export function parseLatestYml(content) {
  const lines = content.split(/\r?\n/)
  let version = null
  let path = null
  let sha512 = null
  let releaseDate = null
  const files = []
  let inFiles = false
  let currentFile = null

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) {
      continue
    }

    if (/^files:\s*$/.test(rawLine)) {
      inFiles = true
      continue
    }

    if (inFiles) {
      const listStart = rawLine.match(/^\s*-\s+([A-Za-z0-9_]+):\s*(.*)$/)
      if (listStart) {
        if (currentFile) files.push(currentFile)
        currentFile = { [listStart[1]]: stripQuotes(listStart[2]) }
        continue
      }
      const nested = rawLine.match(/^\s{2,}([A-Za-z0-9_]+):\s*(.*)$/)
      if (nested && currentFile) {
        currentFile[nested[1]] = stripQuotes(nested[2])
        continue
      }
      if (!/^\s/.test(rawLine)) {
        if (currentFile) {
          files.push(currentFile)
          currentFile = null
        }
        inFiles = false
      }
    }

    const topMatch = rawLine.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (topMatch) {
      const key = topMatch[1]
      const value = stripQuotes(topMatch[2])
      if (key === 'version') version = value
      else if (key === 'path') path = value
      else if (key === 'sha512') sha512 = value
      else if (key === 'releaseDate') releaseDate = value
    }
  }

  if (currentFile) {
    files.push(currentFile)
  }

  return {
    version,
    path,
    sha512,
    releaseDate,
    files: files.map((f) => ({
      url: typeof f.url === 'string' ? f.url : '',
      sha512: typeof f.sha512 === 'string' ? f.sha512 : '',
      size: f.size !== undefined ? Number(f.size) : NaN
    }))
  }
}

async function hashFile(filePath, algorithm, encoding) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash(algorithm)
    const stream = createReadStream(filePath)
    let size = 0
    stream.on('data', (chunk) => {
      size += chunk.length
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolveHash({ digest: hash.digest(encoding), size }))
  })
}

export async function verifyReleaseBundle(bundleDir, options = {}) {
  const resolvedDir = resolve(bundleDir)
  if (!existsSync(resolvedDir)) {
    throw new Error(`Release bundle directory does not exist: ${resolvedDir}`)
  }

  const manifestPath = join(resolvedDir, 'build-manifest.json')
  const sumsPath = join(resolvedDir, 'SHA256SUMS.txt')
  const latestYmlPath = join(resolvedDir, 'latest.yml')

  if (!existsSync(manifestPath)) {
    throw new Error(`Missing build-manifest.json in ${resolvedDir}`)
  }
  if (!existsSync(sumsPath)) {
    throw new Error(`Missing SHA256SUMS.txt in ${resolvedDir}`)
  }
  if (!existsSync(latestYmlPath)) {
    throw new Error(`Missing latest.yml in ${resolvedDir}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || !manifest.version || !Array.isArray(manifest.artifacts)) {
    throw new Error('Invalid build-manifest.json structure')
  }

  const latest = parseLatestYml(readFileSync(latestYmlPath, 'utf8'))
  if (!latest.version || !latest.path || !latest.sha512 || latest.files.length === 0) {
    throw new Error('latest.yml is missing required version, path, sha512, or files entries')
  }

  if (latest.version !== manifest.version) {
    throw new Error(
      `Version mismatch between latest.yml (${latest.version}) and build-manifest.json (${manifest.version})`
    )
  }

  if (options.expectedTag) {
    const expectedNormalized = options.expectedTag.trim()
    if (expectedNormalized !== `v${latest.version}`) {
      throw new Error(
        `Release tag "${expectedNormalized}" does not match bundle version "v${latest.version}"`
      )
    }
  }

  const primaryFile = latest.files[0]
  assertSafeSingleFileName(latest.path, 'latest.yml path')
  assertSafeSingleFileName(primaryFile.url, 'latest.yml files[0].url')
  if (latest.path !== primaryFile.url) {
    throw new Error(
      `latest.yml path (${latest.path}) does not match files[0].url (${primaryFile.url})`
    )
  }

  const installerPath = join(resolvedDir, primaryFile.url)
  if (!existsSync(installerPath)) {
    throw new Error(`Installer referenced by latest.yml is missing: ${installerPath}`)
  }
  const blockmapName = `${primaryFile.url}.blockmap`
  const blockmapPath = join(resolvedDir, blockmapName)
  if (!existsSync(blockmapPath)) {
    throw new Error(`Expected blockmap file is missing: ${blockmapPath}`)
  }

  const exeSha512 = await hashFile(installerPath, 'sha512', 'base64')
  if (!Number.isFinite(primaryFile.size) || exeSha512.size !== primaryFile.size) {
    throw new Error(
      `Installer byte size (${exeSha512.size}) does not match latest.yml size (${primaryFile.size})`
    )
  }
  if (exeSha512.digest !== latest.sha512 || exeSha512.digest !== primaryFile.sha512) {
    throw new Error(`Installer SHA-512 does not match latest.yml`)
  }

  // Verify every entry in SHA256SUMS.txt
  const sumLines = readFileSync(sumsPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (sumLines.length === 0) {
    throw new Error('SHA256SUMS.txt is empty')
  }

  const verifiedFiles = new Map()
  for (const line of sumLines) {
    const match = line.match(/^([0-9a-f]{64})\s{2}(.+)$/i)
    if (!match) {
      throw new Error(`Malformed line in SHA256SUMS.txt: "${line}"`)
    }
    const expectedHex = match[1].toLowerCase()
    const fileName = match[2].trim()
    assertSafeSingleFileName(fileName, 'SHA256SUMS.txt')
    const targetPath = join(resolvedDir, fileName)
    if (!existsSync(targetPath)) {
      throw new Error(`Missing file listed in SHA256SUMS.txt: ${fileName}`)
    }
    const actualSha256 = await hashFile(targetPath, 'sha256', 'hex')
    if (actualSha256.digest.toLowerCase() !== expectedHex) {
      throw new Error(
        `SHA-256 mismatch for ${fileName}: expected ${expectedHex}, got ${actualSha256.digest.toLowerCase()}`
      )
    }
    verifiedFiles.set(fileName, {
      sha256: actualSha256.digest.toLowerCase(),
      size: actualSha256.size
    })
  }

  for (const required of [primaryFile.url, blockmapName, 'latest.yml']) {
    if (!verifiedFiles.has(required)) {
      throw new Error(`Required release file missing from SHA256SUMS.txt: ${required}`)
    }
  }

  return {
    valid: true,
    bundleDir: resolvedDir,
    mode: manifest.mode,
    version: latest.version,
    gitSha: manifest.gitSha ?? null,
    exeFileName: primaryFile.url,
    blockmapFileName: blockmapName,
    byteSize: exeSha512.size,
    sha256: verifiedFiles.get(primaryFile.url).sha256,
    sha512: exeSha512.digest
  }
}

function parseCliArgs(argv) {
  const out = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq === -1) {
      out[arg.slice(2)] = 'true'
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
    }
  }
  return out
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isEntrypoint) {
  const args = parseCliArgs(process.argv.slice(2))
  const bundleDir = args['bundle-dir']
  if (!bundleDir) {
    console.error(
      'Usage: node scripts/verify-release-bundle.mjs --bundle-dir=<dir> [--expected-tag=vX.Y.Z]'
    )
    process.exit(2)
  }
  verifyReleaseBundle(bundleDir, {
    expectedTag: args['expected-tag']
  })
    .then((summary) => {
      console.log(`[PASS] Verified release bundle: ${JSON.stringify(summary)}`)
    })
    .catch((err) => {
      console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}
