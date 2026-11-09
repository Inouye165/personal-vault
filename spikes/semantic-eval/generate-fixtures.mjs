#!/usr/bin/env node
/**
 * Personal Vault — Stage 6A Semantic Evaluation Spike: Nonpersonal Fixture Generator
 *
 * Deterministically generates clearly licensed (CC0 / Public Domain dedicated by author)
 * synthetic nonpersonal raster photograph fixtures using Sharp SVG-to-JPEG/PNG/WebP
 * rendering, plus negative/error fixtures (corrupt image, unsupported HEIC/RAW).
 *
 * Never reads or touches any personal collection.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('../../node_modules/sharp')

export const FIXTURE_CATALOG = [
  {
    id: 'sunset_beach',
    fileName: 'sunset_beach.jpg',
    format: 'jpeg',
    category: 'nature_sunset',
    description: 'Golden orange sunset sun setting over dark blue ocean water horizon',
    svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#8b1e3f"/>
          <stop offset="45%" stop-color="#db3a34"/>
          <stop offset="80%" stop-color="#ff784f"/>
          <stop offset="100%" stop-color="#ffe066"/>
        </linearGradient>
        <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1d3557"/>
          <stop offset="100%" stop-color="#0b132b"/>
        </linearGradient>
      </defs>
      <rect width="640" height="310" fill="url(#sky)"/>
      <circle cx="320" cy="255" r="72" fill="#fff3b0"/>
      <circle cx="320" cy="255" r="58" fill="#ffffff" opacity="0.8"/>
      <rect y="310" width="640" height="170" fill="url(#sea)"/>
      <ellipse cx="320" cy="330" rx="110" ry="12" fill="#ff9f1c" opacity="0.75"/>
      <ellipse cx="320" cy="360" rx="85" ry="9" fill="#ffbf69" opacity="0.65"/>
      <ellipse cx="320" cy="390" rx="55" ry="7" fill="#ffe066" opacity="0.55"/>
    </svg>`
  },
  {
    id: 'sunset_glow',
    fileName: 'sunset_glow.png',
    format: 'png',
    category: 'nature_sunset',
    description: 'Warm red and orange sunset sky with glowing yellow sun above dark waves',
    svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sky2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#540b0e"/>
          <stop offset="50%" stop-color="#e09f3e"/>
          <stop offset="100%" stop-color="#fff3b0"/>
        </linearGradient>
      </defs>
      <rect width="640" height="320" fill="url(#sky2)"/>
      <circle cx="290" cy="240" r="65" fill="#ffea00"/>
      <rect y="320" width="640" height="160" fill="#14213d"/>
      <ellipse cx="290" cy="345" rx="95" ry="14" fill="#fca311" opacity="0.8"/>
      <ellipse cx="290" cy="380" rx="65" ry="10" fill="#ffba08" opacity="0.6"/>
    </svg>`
  },
  {
    id: 'evergreen_forest',
    fileName: 'evergreen_forest.jpg',
    format: 'jpeg',
    category: 'nature_forest',
    description: 'Dense green pine trees and evergreen forest canopy in daylight',
    svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="480" fill="#cfe8ff"/>
      <rect y="350" width="640" height="130" fill="#2d6a4f"/>
      <!-- Trees -->
      <rect x="110" y="310" width="24" height="60" fill="#5c4033"/>
      <polygon points="122,90 40,240 204,240" fill="#1b4332"/>
      <polygon points="122,150 30,320 214,320" fill="#2d6a4f"/>
      <rect x="308" y="320" width="28" height="65" fill="#5c4033"/>
      <polygon points="322,60 220,220 424,220" fill="#081c15"/>
      <polygon points="322,120 205,290 439,290" fill="#1b4332"/>
      <polygon points="322,180 195,340 449,340" fill="#40916c"/>
      <rect x="500" y="315" width="24" height="60" fill="#5c4033"/>
      <polygon points="512,100 430,250 594,250" fill="#1b4332"/>
      <polygon points="512,160 415,330 609,330" fill="#2d6a4f"/>
    </svg>`
  },
  {
    id: 'pine_woods',
    fileName: 'pine_woods.webp',
    format: 'webp',
    category: 'nature_forest',
    description: 'Green woodland with tall pine trees and forest foliage',
    svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="480" fill="#d8f3dc"/>
      <rect y="340" width="640" height="140" fill="#1b4332"/>
      <rect x="168" y="300" width="24" height="60" fill="#4a3525"/>
      <polygon points="180,70 90,230 270,230" fill="#2d6a4f"/>
      <polygon points="180,140 75,315 285,315" fill="#40916c"/>
      <rect x="408" y="300" width="26" height="65" fill="#4a3525"/>
      <polygon points="421,80 320,240 522,240" fill="#1b4332"/>
      <polygon points="421,150 305,320 537,320" fill="#2d6a4f"/>
    </svg>`
  },
  {
    id: 'snowy_mountain_peaks',
    fileName: 'snowy_mountain_peaks.jpg',
    format: 'jpeg',
    category: 'nature_mountain',
    description: 'High rocky mountains with white snow-capped peaks under a blue sky',
    svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="480" fill="#4ea8de"/>
      <!-- Left Mountain -->
      <polygon points="180,90 10,420 350,420" fill="#6c757d"/>
      <polygon points="180,90 115,215 155,195 180,225 210,195 245,215" fill="#ffffff"/>
      <!-- Right Mountain -->
      <polygon points="430,60 220,420 630,420" fill="#495057"/>
      <polygon points="430,60 355,205 395,180 430,215 465,185 505,205" fill="#f8f9fa"/>
      <rect y="400" width="640" height="80" fill="#dee2e6"/>
    </svg>`
  },
  {
    id: 'red_sports_car',
    fileName: 'red_sports_car.jpg',
    format: 'jpeg',
    category: 'vehicle_car',
    description: 'Bright red automobile car with black rubber wheels on a gray road',
    svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="340" fill="#edf2f4"/>
      <rect y="340" width="640" height="140" fill="#4a4e69"/>
      <line x1="40" y1="410" x2="180" y2="410" stroke="#fcca46" stroke-width="10"/>
      <line x1="260" y1="410" x2="400" y2="410" stroke="#fcca46" stroke-width="10"/>
      <line x1="480" y1="410" x2="600" y2="410" stroke="#fcca46" stroke-width="10"/>
      <!-- Car Body -->
      <path d="M 110 290 L 180 200 L 410 200 L 490 270 L 540 280 L 540 345 L 95 345 L 95 290 Z" fill="#d90429"/>
      <!-- Windows -->
      <polygon points="195,212 300,212 300,275 145,275" fill="#90e0ef"/>
      <polygon points="315,212 398,212 465,275 315,275" fill="#90e0ef"/>
      <!-- Headlight -->
      <rect x="515" y="290" width="25" height="18" fill="#ffea00" rx="4"/>
      <!-- Wheels -->
      <circle cx="205" cy="345" r="52" fill="#222222"/>
      <circle cx="205" cy="345" r="28" fill="#adb5bd"/>
      <circle cx="445" cy="345" r="52" fill="#222222"/>
      <circle cx="445" cy="345" r="28" fill="#adb5bd"/>
    </svg>`
  },
  {
    id: 'crimson_sedan',
    fileName: 'crimson_sedan.png',
    format: 'png',
    category: 'vehicle_car',
    description: 'Red sedan car parked on asphalt street with round tires',
    svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="350" fill="#dce1e5"/>
      <rect y="350" width="640" height="130" fill="#343a40"/>
      <rect x="110" y="265" width="420" height="85" rx="22" fill="#e63946"/>
      <path d="M 180 265 L 230 190 L 410 190 L 465 265 Z" fill="#c1121f"/>
      <polygon points="240,202 315,202 315,260 200,260" fill="#a8dadc"/>
      <polygon points="330,202 400,202 445,260 330,260" fill="#a8dadc"/>
      <circle cx="210" cy="350" r="48" fill="#111111"/>
      <circle cx="210" cy="350" r="24" fill="#ced4da"/>
      <circle cx="435" cy="350" r="48" fill="#111111"/>
      <circle cx="435" cy="350" r="24" fill="#ced4da"/>
    </svg>`
  },
  {
    id: 'white_sailboat_sea',
    fileName: 'white_sailboat_sea.jpg',
    format: 'jpeg',
    category: 'nautical_boat',
    description: 'White sailboat with triangular sails floating on blue ocean water',
    svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="330" fill="#90e0ef"/>
      <rect y="330" width="640" height="150" fill="#0077b6"/>
      <!-- Mast -->
      <rect x="312" y="75" width="8" height="245" fill="#495057"/>
      <!-- Sails -->
      <polygon points="306,85 306,295 165,295" fill="#ffffff"/>
      <polygon points="326,105 326,295 455,295" fill="#f8f9fa"/>
      <!-- Hull -->
      <polygon points="150,310 490,310 440,365 200,365" fill="#8d5524"/>
      <rect x="170" y="310" width="300" height="12" fill="#e63946"/>
    </svg>`
  },
  {
    id: 'night_city_skyline',
    fileName: 'night_city_skyline.jpg',
    format: 'jpeg',
    category: 'urban_night',
    description:
      'Dark night sky with stars, moon, and tall city skyscraper buildings with lit yellow windows',
    svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="480" fill="#0b090a"/>
      <!-- Moon & stars -->
      <circle cx="520" cy="85" r="36" fill="#fefae0"/>
      <circle cx="100" cy="60" r="3" fill="#ffffff"/>
      <circle cx="240" cy="45" r="3" fill="#ffffff"/>
      <circle cx="380" cy="75" r="3" fill="#ffffff"/>
      <!-- Skyscrapers -->
      <rect x="50" y="180" width="110" height="300" fill="#161a1d"/>
      <rect x="180" y="110" width="130" height="370" fill="#1f2421"/>
      <rect x="330" y="150" width="120" height="330" fill="#161a1d"/>
      <rect x="470" y="210" width="120" height="270" fill="#1f2421"/>
      <!-- Lit Windows -->
      <g fill="#ffd166">
        <rect x="70" y="205" width="18" height="22"/><rect x="115" y="205" width="18" height="22"/>
        <rect x="70" y="250" width="18" height="22"/><rect x="115" y="250" width="18" height="22"/>
        <rect x="70" y="295" width="18" height="22"/><rect x="115" y="340" width="18" height="22"/>
        <rect x="205" y="135" width="20" height="25"/><rect x="255" y="135" width="20" height="25"/>
        <rect x="205" y="180" width="20" height="25"/><rect x="255" y="180" width="20" height="25"/>
        <rect x="205" y="225" width="20" height="25"/><rect x="255" y="225" width="20" height="25"/>
        <rect x="205" y="270" width="20" height="25"/><rect x="255" y="270" width="20" height="25"/>
        <rect x="205" y="315" width="20" height="25"/><rect x="255" y="315" width="20" height="25"/>
        <rect x="355" y="180" width="20" height="24"/><rect x="400" y="180" width="20" height="24"/>
        <rect x="355" y="230" width="20" height="24"/><rect x="400" y="230" width="20" height="24"/>
        <rect x="355" y="280" width="20" height="24"/><rect x="400" y="330" width="20" height="24"/>
        <rect x="495" y="240" width="20" height="24"/><rect x="540" y="240" width="20" height="24"/>
        <rect x="495" y="290" width="20" height="24"/><rect x="540" y="290" width="20" height="24"/>
      </g>
    </svg>`
  },
  {
    id: 'paper_receipt_document',
    fileName: 'paper_receipt_document.png',
    format: 'png',
    category: 'document_receipt',
    description: 'White paper store receipt invoice with black text lines and barcode at bottom',
    svg: `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="640" height="480" fill="#ced4da"/>
      <rect x="170" y="25" width="300" height="430" fill="#ffffff" stroke="#adb5bd" stroke-width="2"/>
      <!-- Header -->
      <rect x="240" y="50" width="160" height="18" fill="#212529"/>
      <rect x="265" y="78" width="110" height="10" fill="#6c757d"/>
      <line x1="195" y1="105" x2="445" y2="105" stroke="#495057" stroke-width="2" stroke-dasharray="6,4"/>
      <!-- Line items -->
      <rect x="200" y="125" width="140" height="10" fill="#343a40"/><rect x="395" y="125" width="45" height="10" fill="#343a40"/>
      <rect x="200" y="150" width="165" height="10" fill="#343a40"/><rect x="395" y="150" width="45" height="10" fill="#343a40"/>
      <rect x="200" y="175" width="120" height="10" fill="#343a40"/><rect x="395" y="175" width="45" height="10" fill="#343a40"/>
      <rect x="200" y="200" width="150" height="10" fill="#343a40"/><rect x="395" y="200" width="45" height="10" fill="#343a40"/>
      <rect x="200" y="225" width="130" height="10" fill="#343a40"/><rect x="395" y="225" width="45" height="10" fill="#343a40"/>
      <line x1="195" y1="260" x2="445" y2="260" stroke="#212529" stroke-width="3"/>
      <!-- Total -->
      <rect x="200" y="280" width="90" height="16" fill="#000000"/><rect x="375" y="280" width="65" height="16" fill="#000000"/>
      <!-- Barcode -->
      <g fill="#000000">
        <rect x="220" y="340" width="6" height="65"/><rect x="232" y="340" width="3" height="65"/>
        <rect x="240" y="340" width="9" height="65"/><rect x="255" y="340" width="4" height="65"/>
        <rect x="265" y="340" width="8" height="65"/><rect x="279" y="340" width="3" height="65"/>
        <rect x="288" y="340" width="10" height="65"/><rect x="304" y="340" width="4" height="65"/>
        <rect x="314" y="340" width="6" height="65"/><rect x="326" y="340" width="9" height="65"/>
        <rect x="341" y="340" width="3" height="65"/><rect x="350" y="340" width="8" height="65"/>
        <rect x="364" y="340" width="5" height="65"/><rect x="375" y="340" width="10" height="65"/>
        <rect x="391" y="340" width="4" height="65"/><rect x="401" y="340" width="7" height="65"/>
        <rect x="414" y="340" width="5" height="65"/>
      </g>
    </svg>`
  }
]

/**
 * Explicit relevance rubric for evaluating natural-language text queries against
 * the synthetic fixture set. Each query specifies:
 * - queryText: natural-language prompt
 * - positiveIds: fixture IDs that depict the queried concept (expected at top-K)
 * - negativeIds: fixture IDs of unrelated categories (expected to score strictly lower than positives)
 * - minTop1Margin: minimum cosine similarity margin between best positive and best negative
 */
export const EVALUATION_QUERIES = [
  {
    id: 'q_sunset',
    queryText: 'a warm orange sunset over the ocean horizon',
    positiveIds: ['sunset_beach', 'sunset_glow'],
    negativeIds: ['red_sports_car', 'paper_receipt_document', 'evergreen_forest'],
    expectedTopCategory: 'nature_sunset'
  },
  {
    id: 'q_forest',
    queryText: 'green pine trees in an evergreen forest',
    positiveIds: ['evergreen_forest', 'pine_woods'],
    negativeIds: ['sunset_beach', 'red_sports_car', 'paper_receipt_document'],
    expectedTopCategory: 'nature_forest'
  },
  {
    id: 'q_car',
    queryText: 'a bright red car with black wheels on a road',
    positiveIds: ['red_sports_car', 'crimson_sedan'],
    negativeIds: ['evergreen_forest', 'white_sailboat_sea', 'snowy_mountain_peaks'],
    expectedTopCategory: 'vehicle_car'
  },
  {
    id: 'q_mountain',
    queryText: 'snowy mountain peaks under a blue sky',
    positiveIds: ['snowy_mountain_peaks'],
    negativeIds: ['paper_receipt_document', 'red_sports_car', 'night_city_skyline'],
    expectedTopCategory: 'nature_mountain'
  },
  {
    id: 'q_sailboat',
    queryText: 'a white sailboat sailing on blue water',
    positiveIds: ['white_sailboat_sea'],
    negativeIds: ['red_sports_car', 'night_city_skyline', 'paper_receipt_document'],
    expectedTopCategory: 'nautical_boat'
  },
  {
    id: 'q_night_city',
    queryText: 'city skyscraper buildings lit up at night with moon',
    positiveIds: ['night_city_skyline'],
    negativeIds: ['evergreen_forest', 'white_sailboat_sea', 'snowy_mountain_peaks'],
    expectedTopCategory: 'urban_night'
  },
  {
    id: 'q_receipt',
    queryText: 'a paper receipt invoice with a barcode',
    positiveIds: ['paper_receipt_document'],
    negativeIds: ['sunset_beach', 'evergreen_forest', 'white_sailboat_sea'],
    expectedTopCategory: 'document_receipt'
  }
]

export async function generateSyntheticFixtures(targetDir) {
  mkdirSync(targetDir, { recursive: true })
  const generated = []

  for (const item of FIXTURE_CATALOG) {
    const filePath = join(targetDir, item.fileName)
    let pipeline = sharp(Buffer.from(item.svg))
    if (item.format === 'jpeg') {
      pipeline = pipeline.jpeg({ quality: 92 })
    } else if (item.format === 'png') {
      pipeline = pipeline.png()
    } else if (item.format === 'webp') {
      pipeline = pipeline.webp({ quality: 90 })
    }
    const buf = await pipeline.toBuffer()
    writeFileSync(filePath, buf)
    const sha256 = createHash('sha256').update(buf).digest('hex')
    generated.push({
      id: item.id,
      fileName: item.fileName,
      filePath,
      category: item.category,
      description: item.description,
      byteSize: buf.length,
      sha256
    })
  }

  // Also create explicit negative/error test files:
  // 1. Unsupported HEIC placeholder
  const heicPath = join(targetDir, 'unsupported_apple.heic')
  const heicBuf = Buffer.from('ftypheic00000000_mock_heic_header_unsupported')
  writeFileSync(heicPath, heicBuf)

  // 2. Corrupt JPEG file
  const corruptPath = join(targetDir, 'corrupt_truncated.jpg')
  const corruptBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])
  writeFileSync(corruptPath, corruptBuf)

  return {
    validFixtures: generated,
    unsupportedPath: heicPath,
    corruptPath
  }
}
