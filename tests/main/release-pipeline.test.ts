// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyReleaseBundle } from '../../scripts/verify-release-bundle.mjs'

const tempDirs: string[] = []

function makeBundleDir(version = '0.1.1') {
  const dir = mkdtempSync(join(tmpdir(), 'pv-bundle-test-'))
  tempDirs.push(dir)

  const exeName = `Personal-Vault-Setup-${version}.exe`
  const blockmapName = `${exeName}.blockmap`
  const exeBytes = Buffer.from(`fake-installer-binary-${version}`)
  const blockmapBytes = Buffer.from(`fake-blockmap-${version}`)

  writeFileSync(join(dir, exeName), exeBytes)
  writeFileSync(join(dir, blockmapName), blockmapBytes)

  const exeSha512 = createHash('sha512').update(exeBytes).digest('base64')
  const latestYml = [
    `version: ${version}`,
    'files:',
    `  - url: ${exeName}`,
    `    sha512: ${exeSha512}`,
    `    size: ${exeBytes.length}`,
    `path: ${exeName}`,
    `sha512: ${exeSha512}`,
    `releaseDate: '2026-11-22T12:00:00.000Z'`
  ].join('\n')
  writeFileSync(join(dir, 'latest.yml'), `${latestYml}\n`, 'utf8')

  const sums = [exeName, blockmapName, 'latest.yml']
    .map((name) => {
      const hex = createHash('sha256')
        .update(readFileSync(join(dir, name)))
        .digest('hex')
      return `${hex}  ${name}`
    })
    .join('\n')
  writeFileSync(join(dir, 'SHA256SUMS.txt'), `${sums}\n`, 'utf8')

  writeFileSync(
    join(dir, 'build-manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        mode: 'rc',
        version,
        appId: 'com.personalvault.app',
        productName: 'Personal Vault',
        gitSha: 'deadbeef',
        artifacts: []
      },
      null,
      2
    ),
    'utf8'
  )

  return { dir, exeName, blockmapName }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Windows update bundle verification', () => {
  it('accepts a valid release bundle and enforces expected tag match', async () => {
    const { dir, exeName } = makeBundleDir('0.1.1')
    const verified = await verifyReleaseBundle(dir, { expectedTag: 'v0.1.1' })
    expect(verified.valid).toBe(true)
    expect(verified.version).toBe('0.1.1')
    expect(verified.exeFileName).toBe(exeName)

    await expect(verifyReleaseBundle(dir, { expectedTag: 'v0.1.2' })).rejects.toThrow(
      /does not match/i
    )
  })

  it('fails closed on tampered installer or SHA-256/SHA-512 mismatch', async () => {
    const { dir, exeName } = makeBundleDir('0.1.1')
    writeFileSync(join(dir, exeName), Buffer.from('tampered-binary-bytes-with-same-len'))
    await expect(verifyReleaseBundle(dir)).rejects.toThrow(/size|SHA-512|SHA-256/i)
  })
})
