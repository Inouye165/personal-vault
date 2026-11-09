#!/usr/bin/env node
/**
 * Personal Vault — Stage 6A Semantic Evaluation Spike: Model Fetcher
 *
 * Downloads the pinned CLIP ViT-B/32 quantized ONNX weights and tokenizer
 * artifacts from Xenova/clip-vit-base-patch32 (commit 6b7c523703ae26e39be4b03774966f8571c7f523)
 * into the gitignored spikes/semantic-eval/.model-cache/ directory and verifies
 * exact byte sizes and SHA-256 digests.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const MODEL_CACHE_DIR = resolve(__dirname, '.model-cache', 'Xenova--clip-vit-base-patch32')

export const MODEL_REPO = 'Xenova/clip-vit-base-patch32'
export const MODEL_COMMIT = '6b7c523703ae26e39be4b03774966f8571c7f523'

export const REQUIRED_MODEL_FILES = [
  {
    relativePath: 'config.json',
    expectedBytes: 4524,
    expectedSha256: '493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495'
  },
  {
    relativePath: 'preprocessor_config.json',
    expectedBytes: 520,
    expectedSha256: '6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f'
  },
  {
    relativePath: 'tokenizer.json',
    expectedBytes: 2224119,
    expectedSha256: 'f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd'
  },
  {
    relativePath: 'tokenizer_config.json',
    expectedBytes: 775,
    expectedSha256: '60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967'
  },
  {
    relativePath: 'special_tokens_map.json',
    expectedBytes: 472,
    expectedSha256: 'c4864a9376a8401918425bed71fc14fc0e81f9b59ec45c1cf96cccb2df508eac'
  },
  {
    relativePath: 'onnx/vision_model_quantized.onnx',
    expectedBytes: 89117001,
    expectedSha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299'
  },
  {
    relativePath: 'onnx/text_model_quantized.onnx',
    expectedBytes: 64504507,
    expectedSha256: '73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a'
  }
]

function computeSha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export async function ensureModelDownloaded() {
  mkdirSync(join(MODEL_CACHE_DIR, 'onnx'), { recursive: true })
  const manifest = []

  for (const item of REQUIRED_MODEL_FILES) {
    const destPath = join(MODEL_CACHE_DIR, item.relativePath)
    let valid = false

    if (existsSync(destPath)) {
      const existingBuf = readFileSync(destPath)
      if (existingBuf.length === item.expectedBytes) {
        const sha256 = computeSha256(existingBuf)
        if (!item.expectedSha256 || sha256 === item.expectedSha256) {
          valid = true
          manifest.push({
            file: item.relativePath,
            bytes: existingBuf.length,
            sha256,
            cached: true
          })
        }
      }
    }

    if (!valid) {
      const url = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_COMMIT}/${item.relativePath}`
      console.log(
        `[fetch-model] Downloading ${item.relativePath} (${(item.expectedBytes / (1024 * 1024)).toFixed(2)} MiB)...`
      )
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`)
      }
      const arrayBuf = await res.arrayBuffer()
      const buf = Buffer.from(arrayBuf)
      if (buf.length !== item.expectedBytes) {
        throw new Error(
          `Byte size mismatch for ${item.relativePath}: expected ${item.expectedBytes}, got ${buf.length}`
        )
      }
      const sha256 = computeSha256(buf)
      if (item.expectedSha256 && sha256 !== item.expectedSha256) {
        throw new Error(
          `SHA-256 mismatch for ${item.relativePath}: expected ${item.expectedSha256}, got ${sha256}`
        )
      }
      writeFileSync(destPath, buf)
      manifest.push({
        file: item.relativePath,
        bytes: buf.length,
        sha256,
        cached: false
      })
    }
  }

  return {
    modelId: MODEL_REPO,
    commit: MODEL_COMMIT,
    cacheDir: MODEL_CACHE_DIR,
    files: manifest,
    totalBytes: manifest.reduce((acc, f) => acc + f.bytes, 0)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureModelDownloaded()
    .then((result) => {
      console.log('\n[fetch-model] Model Provisioning Complete & Verified:')
      console.log(`  Model: ${result.modelId} @ ${result.commit}`)
      console.log(
        `  Total Disk Size: ${result.totalBytes.toLocaleString()} bytes (${(result.totalBytes / (1024 * 1024)).toFixed(2)} MiB)`
      )
      for (const f of result.files) {
        console.log(
          `  - ${f.file}: ${f.bytes} bytes | sha256: ${f.sha256} (${f.cached ? 'cached' : 'downloaded'})`
        )
      }
    })
    .catch((err) => {
      console.error('[fetch-model] Error:', err)
      process.exit(1)
    })
}
