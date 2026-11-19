#!/usr/bin/env node
/**
 * Personal Vault — Stage 7D Document Semantic Evaluation Spike: Model Fetcher
 *
 * Downloads pinned quantized ONNX text-embedding models into the gitignored
 * spikes/doc-semantic-eval/.model-cache/ directory and records exact byte sizes
 * and SHA-256 digests.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const CACHE_ROOT = resolve(__dirname, '.model-cache')

export const CANDIDATE_MODELS = [
  {
    key: 'bge-small-en-v1.5',
    repo: 'Xenova/bge-small-en-v1.5',
    commit: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'onnx/model_quantized.onnx'
    ]
  },
  {
    key: 'all-MiniLM-L6-v2',
    repo: 'Xenova/all-MiniLM-L6-v2',
    commit: '751bff37182d3f1213fa05d7196b954e230abad9',
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'onnx/model_quantized.onnx'
    ]
  }
]

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export async function ensureCandidateModels() {
  const results = []
  for (const model of CANDIDATE_MODELS) {
    const dir = join(CACHE_ROOT, model.key)
    mkdirSync(join(dir, 'onnx'), { recursive: true })
    const files = []
    let totalBytes = 0

    for (const rel of model.files) {
      const dest = join(dir, rel)
      let buf
      let downloaded = false
      if (existsSync(dest)) {
        buf = readFileSync(dest)
      } else {
        const url = `https://huggingface.co/${model.repo}/resolve/${model.commit}/${rel}`
        const res = await fetch(url, { redirect: 'follow' })
        if (!res.ok) {
          throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
        }
        buf = Buffer.from(await res.arrayBuffer())
        writeFileSync(dest, buf)
        downloaded = true
      }
      totalBytes += buf.length
      files.push({
        relativePath: rel,
        bytes: buf.length,
        sha256: sha256Hex(buf),
        downloaded
      })
    }

    results.push({
      key: model.key,
      repo: model.repo,
      commit: model.commit,
      dir,
      totalBytes,
      files
    })
  }
  return results
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await ensureCandidateModels()
  console.log(JSON.stringify(res, null, 2))
}
