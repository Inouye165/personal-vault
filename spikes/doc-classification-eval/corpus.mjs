/**
 * Personal Vault — Stage 7E Planning & Evaluation: Synthetic Multi-Label Document Corpus
 *
 * 100% synthetic in-memory fixtures (zero personal data, zero filesystem scanning).
 * Includes clear canonical documents, multi-label overlapping documents,
 * unextracted/encrypted documents, noisy OCR documents, and adversarial edge cases
 * designed to stress conservative clutter filtering and false-positive boundaries.
 *
 * Ground-truth schema:
 * - expectedPurposes: subset of ['legal', 'lists', 'instructions', 'receipts', 'recipes']
 * - expectedFallbackStatus: 'classified' | 'other' | 'unknown'
 *     - 'classified' when expectedPurposes.length > 0
 *     - 'other' when readable text exists but belongs to none of the 5 specific purposes
 *     - 'unknown' when no readable text is available (unextracted, encrypted, empty OCR)
 * - expectedOrigins: subset of ['personal', 'software_project', 'application_system']
 *     (empty array [] means origin is genuinely 'unknown' from available evidence)
 * - valuablePersonal: true if hiding this document as software/system clutter would be a
 *     harmful false-hide of personal or user-authored material.
 * - expectedClutterCandidate: true ONLY for unambiguous software/repository boilerplate or
 *     machine-generated application/system logs/dumps safe to hide when clutter filter is enabled.
 */

export const PURPOSE_LABELS = ['legal', 'lists', 'instructions', 'receipts', 'recipes']
export const ORIGIN_LABELS = ['personal', 'software_project', 'application_system']

export const SYNTHETIC_CLASSIFICATION_CORPUS = [
  // ─── 1. Clear Personal Documents (Single & Multi-Label) ────────────────────
  {
    id: 'doc-01-residential-lease',
    sliceCategory: 'canonical_personal',
    fileName: '2026_Oakwood_Apartment_Lease_Agreement.pdf',
    extension: '.pdf',
    relativePath: 'Housing/2026_Oakwood_Apartment_Lease_Agreement.pdf',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `RESIDENTIAL LEASE AGREEMENT
THIS LEASE AGREEMENT ("Agreement") is entered into on March 1, 2026, by and between Oakwood Property Holdings LLC ("Landlord") and Elena Vance ("Tenant") for the residential premises located at 412 Oakwood Ave, Apt 3B.
1. TERM AND RENT: Tenant agrees to pay monthly rent of $2,150.00 due on the 1st calendar day of each month.
2. GOVERNING LAW AND SEVERABILITY: This Agreement shall be governed by the laws of the State of Washington. If any provision is held invalid, the remainder shall remain in full force and effect.
3. INDEMNIFICATION: Tenant hereby agrees to indemnify and hold harmless Landlord against claims arising from Tenant's negligence.
IN WITNESS WHEREOF, the parties have executed this Lease Agreement as of the date first written above.`,
    expectedPurposes: ['legal'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-02-grocery-checklist',
    sliceCategory: 'canonical_personal',
    fileName: 'weekly-grocery-and-errands.md',
    extension: '.md',
    relativePath: 'Notes/weekly-grocery-and-errands.md',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `# Saturday Grocery & Errands Checklist
- [ ] Whole milk (1 gallon)
- [ ] Organic sourdough loaf
- [ ] Roma tomatoes (6)
- [x] Dish soap refill
- [ ] AA rechargeable batteries
- [ ] Pick up dry cleaning before 5pm
- [ ] Drop library books in return slot`,
    expectedPurposes: ['lists'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-03-espresso-descaling-manual',
    sliceCategory: 'canonical_personal',
    fileName: 'Breville_Barista_Descaling_Guide.pdf',
    extension: '.pdf',
    relativePath: 'Manuals/Kitchen/Breville_Barista_Descaling_Guide.pdf',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `HOME ESPRESSO MACHINE — CARE & DESCALING INSTRUCTIONS
Safety Warnings: Unplug the appliance and allow the thermoblock to cool completely before cleaning the steam wand.
Prerequisites: 1 packet descaling powder, 1 liter warm filtered water, empty 2L container.
Step 1: Remove the water filter holder from the rear water tank and dissolve the descaling powder completely in warm water.
Step 2: Press and hold the 2-Cup button while turning the power unit on to enter descale mode.
Step 3: Turn the steam dial to the manual position until half the solution flushes through the wand.
Step 4: Rinse the tank thoroughly and repeat with fresh water before brewing espresso.`,
    expectedPurposes: ['instructions'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-04-vet-clinic-receipt',
    sliceCategory: 'canonical_personal',
    fileName: 'cedar_vet_invoice_paid.pdf',
    extension: '.pdf',
    relativePath: 'Pets/Milo/cedar_vet_invoice_paid.pdf',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `CEDAR GROVE VETERINARY CLINIC
Receipt #: INV-2026-08914    Date: 2026-04-09
Client: Elena Vance          Patient: Milo (Canine)
----------------------------------------------------
Annual Wellness Exam                        $78.00
Rabies 3-Year Booster                       $34.00
Heartworm Preventive (6-pack)               $62.50
----------------------------------------------------
Subtotal:                                  $174.50
Sales Tax (8.8%):                            $5.50
Total Paid:                                $180.00
Payment Method: VISA **** 3910 (Auth #774102) — Balance Due: $0.00`,
    expectedPurposes: ['receipts'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-05-sourdough-focaccia-recipe',
    sliceCategory: 'canonical_personal',
    fileName: 'rosemary-focaccia.txt',
    extension: '.txt',
    relativePath: 'Kitchen/Baking/rosemary-focaccia.txt',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `Crispy Rosemary Sea Salt Focaccia
Prep time: 20 mins | Bake time: 25 mins | Servings: 8

Ingredients:
- 500 grams bread flour
- 400 grams warm water
- 2 tsp instant yeast
- 2 tbsp extra-virgin olive oil (plus 2 tbsp for pan)
- 10 grams fine sea salt
- 2 sprigs fresh rosemary, needles stripped

Directions:
1. Whisk warm water, yeast, and olive oil in a large bowl, then fold in flour and salt until no dry streaks remain.
2. Cover and proof at room temperature for 2 hours, performing two sets of stretch-and-folds.
3. Preheat oven to 450°F (230°C). Dimple the dough generously with oiled fingers, scatter rosemary and flaky salt, and bake for 24-26 minutes until deep golden brown.`,
    expectedPurposes: ['recipes'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-06-personal-letter-other',
    sliceCategory: 'canonical_personal',
    fileName: 'eulogy-draft-uncle-arthur.docx',
    extension: '.docx',
    relativePath: 'Family/eulogy-draft-uncle-arthur.docx',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `Thank you everyone for traveling so far to celebrate Uncle Arthur's life this afternoon. Whenever I think of his workshop on Bainbridge Island, I remember the smell of cedar shavings, the old brass barometer above his workbench, and the patience he showed teaching every niece and nephew how to read tide charts before heading out on Puget Sound. He believed that curiosity and kindness mattered far more than hurry.`,
    expectedPurposes: [],
    expectedFallbackStatus: 'other',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },

  // ─── 2. Multi-Label Overlapping Documents (Cross-Axis & Within-Purpose) ────
  {
    id: 'doc-07-thanksgiving-combo',
    sliceCategory: 'multi_label_overlap',
    fileName: 'thanksgiving-dinner-master-plan.md',
    extension: '.md',
    relativePath: 'Holidays/thanksgiving-dinner-master-plan.md',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `# Thanksgiving Hosting Plan & Cranberry Relish Recipe

## Shopping & Prep Checklist
- [ ] 14 lb pasture-raised turkey
- [ ] 3 bags fresh cranberries (12 oz each)
- [ ] 2 navel oranges
- [x] Heavy roasting pan & probe thermometer
- [ ] Folded place cards for 10 guests

## Cranberry-Orange Relish Ingredients
- 12 oz fresh cranberries, rinsed
- 3/4 cup granulated sugar
- 1 tsp grated orange zest
- 1/2 cup fresh squeezed orange juice
- 1 pinch cinnamon

## Cooking Instructions
Step 1: Preheat oven to 325°F and position the rack in the lowest third of the oven.
Step 2: Combine cranberries, sugar, orange juice, and zest in a saucepan; simmer for 12 minutes until berries pop, then chill overnight.
Step 3: Pat turkey dry, season generously, and roast until the thickest part of the thigh registers 165°F.`,
    expectedPurposes: ['recipes', 'lists', 'instructions'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-08-lease-with-deposit-receipt',
    sliceCategory: 'multi_label_overlap',
    fileName: 'Sublease_Addendum_and_Deposit_Receipt.pdf',
    extension: '.pdf',
    relativePath: 'Housing/Sublease_Addendum_and_Deposit_Receipt.pdf',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `SUBLEASE ADDENDUM AND SECURITY DEPOSIT RECEIPT
WHEREAS, Sublessor Maya Patel and Sublessee Elena Vance hereby execute this binding Addendum governed by State law, all terms of the Master Lease are incorporated herein by reference. Severability and indemnification provisions remain binding upon both parties.

OFFICIAL PAYMENT RECEIPT (#DEP-2026-114)
Received From: Elena Vance    Date Paid: 2026-03-02
Security Deposit:             $1,500.00
First Month Pro-Rated Rent:     $700.00
Total Paid:                   $2,200.00
Payment Method: Cashier's Check #990418 — Balance Due: $0.00`,
    expectedPurposes: ['legal', 'receipts'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-09-itemized-moving-inventory-csv',
    sliceCategory: 'multi_label_overlap',
    fileName: 'home-insurance-contents-inventory.csv',
    extension: '.csv',
    relativePath: 'Insurance/home-insurance-contents-inventory.csv',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `ItemNumber,Room,Description,SerialNumber,EstimatedReplacementValue
1,Living Room,Sony 65-inch OLED Television,SN-8849201,$1699.00
2,Study,Herman Miller Aeron Chair,HM-220194,$1150.00
3,Kitchen,KitchenAid Stand Mixer,KA-773120,$399.00
4,Bedroom,Solid Walnut Dressers (Pair),N/A,$1400.00
5,Garage,Trek Domane Road Bicycle,WTU3019942,$2400.00
6,Study, Brother Laser Scanner Printer,BR-00912,$289.00`,
    expectedPurposes: ['lists'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-10-repo-mit-license',
    sliceCategory: 'multi_label_overlap',
    fileName: 'LICENSE.txt',
    extension: '.txt',
    relativePath: 'open-weather-widget/LICENSE.txt',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `SPDX-License-Identifier: MIT
MIT License

Copyright (c) 2025 OpenWeatherWidget Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.`,
    expectedPurposes: ['legal'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['software_project'],
    valuablePersonal: false,
    expectedClutterCandidate: true
  },
  {
    id: 'doc-11-repo-readme-setup',
    sliceCategory: 'multi_label_overlap',
    fileName: 'README.md',
    extension: '.md',
    relativePath: 'repos/open-weather-widget/README.md',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `# @acme/open-weather-widget

[![CI Build](https://img.shields.io/github/actions/workflow/status/acme/widget/ci.yml)]()

Lightweight TypeScript SDK and React component for rendering local forecast tiles.

## Prerequisites & Installation

Install via npm or pnpm:

\`\`\`bash
npm install @acme/open-weather-widget
git clone https://github.com/acme/open-weather-widget.git
npm run test && npm run typecheck
\`\`\`

## API Usage Instructions

1. Import \`WeatherWidget\` into your application root.
2. Configure \`apiBaseUrl\` and run \`npm run build\` before deploying.

\`\`\`tsx
import { WeatherWidget } from '@acme/open-weather-widget'
export const App = () => <WeatherWidget units="metric" />
\`\`\``,
    expectedPurposes: ['instructions'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['software_project'],
    valuablePersonal: false,
    expectedClutterCandidate: true
  },
  {
    id: 'doc-12-repo-sprint-backlog',
    sliceCategory: 'multi_label_overlap',
    fileName: 'TODO.md',
    extension: '.md',
    relativePath: 'repos/open-weather-widget/docs/TODO.md',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `# v2.4.0 Engineering Backlog & Release Checklist

Repository: \`github.com/acme/open-weather-widget\`

- [x] Migrate ESLint flat config and bump \`typescript\` to \`^5.7.0\` (#142)
- [x] Fix race condition in \`fetchForecastTile()\` AbortController cleanup (#149)
- [ ] Add Vitest unit tests for \`parseIsoWindVector\` edge cases (#153)
- [ ] Update \`package.json\` exports map for CommonJS/ESM dual publish
- [ ] Tag \`v2.4.0-rc.1\` and verify GitHub Actions npm provenance workflow`,
    expectedPurposes: ['lists'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['software_project'],
    valuablePersonal: false,
    expectedClutterCandidate: true
  },
  {
    id: 'doc-13-third-party-notices',
    sliceCategory: 'multi_label_overlap',
    fileName: 'THIRD_PARTY_NOTICES.md',
    extension: '.md',
    relativePath: 'repos/open-weather-widget/THIRD_PARTY_NOTICES.md',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `# Third-Party Open Source Software Notices

This distribution bundles the following open-source npm packages:

## fast-xml-parser@5.12.1
- License: MIT
- Repository: https://github.com/NaturalIntelligence/fast-xml-parser
- SPDX-License-Identifier: MIT

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software")...

## pdfjs-dist@6.5.438
- License: Apache-2.0
- Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.`,
    expectedPurposes: ['legal'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['software_project'],
    valuablePersonal: false,
    expectedClutterCandidate: true
  },
  {
    id: 'doc-14-installed-app-eula',
    sliceCategory: 'multi_label_overlap',
    fileName: 'EULA.rtf',
    extension: '.rtf',
    relativePath: 'ProgramBackup/AcmeScannerDriver_v4.2/EULA.rtf',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `END-USER LICENSE AGREEMENT FOR ACME USB SCANNER DRIVER RUNTIME v4.2.108
Setup Installer Component: AcmeScanSvc.exe (Build 4.2.108.0, Win64)
IMPORTANT — READ CAREFULLY BEFORE INSTALLING THIS DEVICE DRIVER SOFTWARE:
By clicking "Accept" in the Setup Wizard, Licensee agrees to be bound by the terms of this End-User License Agreement ("EULA") with Acme Imaging Systems Inc. ("Licensor").
1. GRANT OF LICENSE: Licensor grants a non-exclusive license to install the driver binary on a single workstation.
2. LIMITATION OF LIABILITY AND GOVERNING LAW: In no event shall Licensor be liable for consequential damages. Governed by Delaware law.`,
    expectedPurposes: ['legal'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['application_system'],
    valuablePersonal: false,
    expectedClutterCandidate: true
  },

  // ─── 3. Application / System Clutter Documents ─────────────────────────────
  {
    id: 'doc-15-updater-daemon-log',
    sliceCategory: 'canonical_system',
    fileName: 'updater_daemon_2026_04_11.txt',
    extension: '.txt',
    relativePath: 'AppLogs/AcmeSync/updater_daemon_2026_04_11.txt',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `2026-04-11T03:14:09.112Z [INFO] [pid:8824] [tid:104] ServiceHost starting background telemetry flush (build=14.2.0-win32-x64)
2026-04-11T03:14:09.450Z [WARN] [pid:8824] [tid:219] NamedPipe IPC retry count=2 pipe=\\\\.\\pipe\\AcmeSyncDaemon
2026-04-11T03:14:10.004Z [ERROR] [pid:8824] [tid:219] HttpTransportException: ECONNRESET polling https://telemetry.acme-internal.example/v2/heartbeat
2026-04-11T03:14:10.018Z [INFO] [pid:8824] [tid:104] Scheduled next background check in 3600000ms; exitCode=0`,
    expectedPurposes: [],
    expectedFallbackStatus: 'other',
    expectedOrigins: ['application_system'],
    valuablePersonal: false,
    expectedClutterCandidate: true
  },
  {
    id: 'doc-16-crash-dump-stacktrace',
    sliceCategory: 'canonical_system',
    fileName: 'crash_report_0xC0000005.txt',
    extension: '.txt',
    relativePath: 'Diagnostics/CrashReports/crash_report_0xC0000005.txt',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `Unhandled Exception Report — Process: RenderWorker.exe (PID 14920)
Exception Code: 0xC0000005 (EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000018)
OS Version: Windows NT 10.0.22631 x64
Stack Trace:
  at RenderContext::FlushCommandBuffer (D:\\buildagent\\work\\gfx\\render_context.cpp:412)
  at WorkerThread::RunLoop (D:\\buildagent\\work\\core\\worker_thread.cpp:188)
  at BaseThreadInitThunk+0x14 (KERNEL32.DLL)
  at RtlUserThreadStart+0x21 (ntdll.dll)
Loaded Modules: KERNEL32.DLL, ntdll.dll, d3d11.dll, dxgi.dll`,
    expectedPurposes: [],
    expectedFallbackStatus: 'other',
    expectedOrigins: ['application_system'],
    valuablePersonal: false,
    expectedClutterCandidate: true
  },
  {
    id: 'doc-17-repo-api-architecture',
    sliceCategory: 'canonical_software',
    fileName: 'ARCHITECTURE.md',
    extension: '.md',
    relativePath: 'repos/open-weather-widget/ARCHITECTURE.md',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `# Internal Module Architecture

The package is split into \`src/client/\`, \`src/parser/\`, and \`src/cache/\`.

\`\`\`ts
export interface ForecastCacheAdapter {
  get(key: string): Promise<Uint8Array | null>
  set(key: string, payload: Uint8Array, ttlMs: number): Promise<void>
}
\`\`\`

All pull requests must pass \`tsc --noEmit\`, \`eslint .\`, and Vitest coverage thresholds in GitHub Actions before merging to \`main\`.`,
    expectedPurposes: [],
    expectedFallbackStatus: 'other',
    expectedOrigins: ['software_project'],
    valuablePersonal: false,
    expectedClutterCandidate: true
  },

  // ─── 4. Adversarial & Ambiguous Cases (Valuable Personal Must NOT Hide!) ───
  {
    id: 'doc-18-adv-personal-in-dev-folder',
    sliceCategory: 'adversarial_clutter_safety',
    fileName: 'home-network-and-isp-recovery.md',
    extension: '.md',
    relativePath: 'Projects/dev/notes/home-network-and-isp-recovery.md',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `# Our House Fiber Internet & Wi-Fi Setup Instructions

Account Holder: Elena Vance ( CenturyFiber Acct #884-219-004 )
Emergency Support Phone: 1-800-555-0199

## Steps if Living Room Wi-Fi Drops
1. Unplug the white ONT fiber box in the hallway closet for 30 seconds.
2. Reconnect power and wait until the Optical light turns solid green.
3. If the study desktop still cannot reach the router, test from terminal:

\`\`\`bash
ping 192.168.1.1
\`\`\`

Guest Wi-Fi SSID: OakwoodGuest (for visiting family).`,
    expectedPurposes: ['instructions'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-19-adv-narrative-recipe-in-system-dir',
    sliceCategory: 'adversarial_clutter_safety',
    fileName: 'nonna-mushroom-risotto.md',
    extension: '.md',
    relativePath: 'Downloads/system-backup/nonna-mushroom-risotto.md',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `Nonna's Sunday Porcini Risotto

Whenever autumn arrived in Milan, Nonna soaked a handful of dried porcini mushrooms in a bowl of hot stock while warming olive oil and butter in her heavy copper pot. She always chopped one small yellow onion finely, letting it soften slowly before stirring in two cups of carnaroli rice until the edges turned translucent. Add a splash of dry white wine, then ladle the warm mushroom broth one scoop at a time, stirring patiently for eighteen minutes until creamy, and finish off the heat with grated Parmigiano-Reggiano and black pepper.`,
    expectedPurposes: ['recipes'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-20-adv-journal-keyword-trap',
    sliceCategory: 'adversarial_false_positive',
    fileName: '2026-04-career-journal.txt',
    extension: '.txt',
    relativePath: 'Journal/2026-04-career-journal.txt',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `April 12, 2026 — Personal Reflection
I spent most of Tuesday afternoon reviewing TypeScript code and git pull requests at the office, and honestly I feel ready for a quieter summer trip. On the walk home I realized I lost the paper coffee receipt from the bakery, called Mom about her lemon cake recipe, and wondered whether breaking an apartment lease early is even legal in our county if I decide to move closer to the ferry terminal.`,
    expectedPurposes: [],
    expectedFallbackStatus: 'other',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-21-adv-docker-cookbook-metaphor',
    sliceCategory: 'adversarial_false_positive',
    fileName: 'docker-compose-recipes.md',
    extension: '.md',
    relativePath: 'repos/infra-guides/docker-compose-recipes.md',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `# Docker Compose Cookbook: Production Container Recipes

Follow these step-by-step instructions to configure local PostgreSQL containers for integration tests.

## Prerequisites
- Docker Engine \`>= 26.0\`
- Node.js \`v22.18.0\`

## Step-by-Step Setup
1. Copy \`.env.example\` to \`.env\` in your repository root.
2. Launch the container stack and run schema migrations:

\`\`\`bash
docker compose up -d postgres
npm run db:migrate && npm test
\`\`\``,
    expectedPurposes: ['instructions'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['software_project'],
    valuablePersonal: false,
    expectedClutterCandidate: true
  },
  {
    id: 'doc-22-adv-app-exported-personal-invoice',
    sliceCategory: 'adversarial_clutter_safety',
    fileName: 'app_system_export_20260402_log.pdf',
    extension: '.pdf',
    relativePath: 'Downloads/app_system_export_20260402_log.pdf',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `PACIFIC NORTHWEST DENTAL ASSOCIATES — PATIENT STATEMENT & PAYMENT RECEIPT
Generated by BillingPortalApp v9.4 (Export ID: SYS-884120)
Patient: Elena Vance           Statement Date: 2026-04-02
----------------------------------------------------------
D1110 Adult Prophylaxis Cleaning                   $145.00
D0274 Bitewing Radiographs (4 films)                $85.00
Insurance Plan Adjustment:                         -$160.00
Patient Co-Pay Paid (Mastercard ****1104):          $70.00
Remaining Balance Due:                               $0.00`,
    expectedPurposes: ['receipts'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-23-adv-personal-readme-in-tax-folder',
    sliceCategory: 'adversarial_clutter_safety',
    fileName: 'README.txt',
    extension: '.txt',
    relativePath: 'Taxes/2025/README.txt',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `Notes for our CPA (David Kim) before filing 2025 joint return:
1. Remember to include the 1099-INT from Ally Savings and the charitable donation receipt for Seattle Food Lifeline.
2. Check whether our heat-pump installation qualifies for the residential clean energy credit.`,
    expectedPurposes: ['lists'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-24-adv-freelance-contract-in-project-dir',
    sliceCategory: 'adversarial_clutter_safety',
    fileName: 'Client_Consulting_Services_Agreement_Signed.pdf',
    extension: '.pdf',
    relativePath: 'Projects/client-portal/admin/Client_Consulting_Services_Agreement_Signed.pdf',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `INDEPENDENT CONTRACTOR CONSULTING AGREEMENT
THIS AGREEMENT is made effective February 10, 2026 between Elena Vance ("Consultant", SSN/EIN on file) and Cascade Harbor Bakery LLC ("Client").
1. COMPENSATION: Client shall pay Consultant $125.00 per hour upon biweekly invoice submission.
2. CONFIDENTIALITY AND INTELLECTUAL PROPERTY: Upon full payment, Consultant assigns deliverable work product to Client.
3. GOVERNING LAW: Governed by the laws of the State of Washington.
Signed: Elena Vance /s/    Signed: Marcus Reed, Owner /s/`,
    expectedPurposes: ['legal'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-25-adv-personal-cli-cheatsheet',
    sliceCategory: 'adversarial_clutter_safety',
    fileName: 'my-backup-commands.md',
    extension: '.md',
    relativePath: 'Notes/my-backup-commands.md',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `# Personal External Drive Backup Steps

How I copy my family photo archive to the Seagate USB drive once a month:

1. Plug in the encrypted USB drive (\`E:\\\`).
2. Run robocopy in dry-run mode first so nothing is overwritten:

\`\`\`powershell
robocopy D:\\FamilyPhotos E:\\FamilyPhotosBackup /E /L
\`\`\``,
    expectedPurposes: ['instructions'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },

  // ─── 5. Noisy OCR & Subtle Prose Cases (Model vs. Rules Stress Tests) ──────
  {
    id: 'doc-26-ocr-degraded-hardware-receipt',
    sliceCategory: 'noisy_ocr',
    fileName: 'scan_0042.pdf',
    extension: '.pdf',
    relativePath: 'Scans/2026/scan_0042.pdf',
    extractionStatus: 'no_text_ocr_required',
    textSourceKind: 'ocr',
    ocrMeanConfidence: 78.5,
    text: `GREENWOOD HARDWARE & LUMBER
4810 PHINNEY AVE N
TRN#: 0094182   04/05/2026
1x CEDAR PLANTER B0X        34.99
2x POTT1NG S0IL 1.5CF       23.98
BRASS HOSE NOZZLE           12.49
SUBT0TAL                    71.46
WA STATE TAX 10.25%          7.32
T0TAL PAID                 $78.78
AMEX **** 2004 APPR 61829`,
    expectedPurposes: ['receipts'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-27-informal-neighbor-agreement',
    sliceCategory: 'subtle_prose',
    fileName: 'shared-cedar-fence-letter.docx',
    extension: '.docx',
    relativePath: 'Home/Fence/shared-cedar-fence-letter.docx',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `Shared Boundary Fence Replacement Understanding — May 4, 2026
We, Elena Vance (412 Oakwood) and Samuel Cho (416 Oakwood), agree to split equally the $4,600 quote from Ballard Cedar Fencing to replace the 68-foot wooden boundary fence between our backyards. Each household will pay $2,300 directly to the contractor upon completion, and both neighbors agree to maintain their side's stain in good condition.
Signed: Elena Vance    Signed: Samuel Cho`,
    expectedPurposes: ['legal'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-28-narrative-post-op-care',
    sliceCategory: 'subtle_prose',
    fileName: 'wisdom-tooth-recovery-sheet.pdf',
    extension: '.pdf',
    relativePath: 'Medical/wisdom-tooth-recovery-sheet.pdf',
    extractionStatus: 'extracted',
    textSourceKind: 'ocr',
    ocrMeanConfidence: 88.0,
    text: `Oral Surgery Discharge Care for Elena Vance
Keep firm gauze pressure over the surgical site for forty-five minutes after returning home, and apply a cold pack to your cheek in twenty-minute intervals throughout the first afternoon. Avoid drinking through a straw, rinsing vigorously, or eating crunchy foods for the first three days. Starting tomorrow morning, gently rinse with warm salt water after meals and take prescribed ibuprofen with food as directed.`,
    expectedPurposes: ['instructions'],
    expectedFallbackStatus: 'classified',
    expectedOrigins: ['personal'],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-29-minimal-ambiguous-note',
    sliceCategory: 'ambiguous_short',
    fileName: 'scratch.txt',
    extension: '.txt',
    relativePath: 'Desktop/scratch.txt',
    extractionStatus: 'extracted',
    textSourceKind: 'native',
    ocrMeanConfidence: null,
    text: `Tuesday 2:30pm — Room 404, bring blue folder.`,
    expectedPurposes: [],
    expectedFallbackStatus: 'unknown',
    expectedOrigins: [],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },

  // ─── 6. Unextracted / Encrypted / Unsupported Honest-Unknown Cases ─────────
  {
    id: 'doc-30-encrypted-tax-pdf',
    sliceCategory: 'honest_unknown',
    fileName: '2025_Federal_Tax_Return_Receipt_Locked.pdf',
    extension: '.pdf',
    relativePath: 'Taxes/2025/2025_Federal_Tax_Return_Receipt_Locked.pdf',
    extractionStatus: 'password_protected',
    textSourceKind: null,
    ocrMeanConfidence: null,
    text: null,
    expectedPurposes: [],
    expectedFallbackStatus: 'unknown',
    expectedOrigins: [],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-31-unextracted-scanned-deed',
    sliceCategory: 'honest_unknown',
    fileName: 'County_Property_Deed_Scan.pdf',
    extension: '.pdf',
    relativePath: 'Housing/County_Property_Deed_Scan.pdf',
    extractionStatus: 'no_text_ocr_required',
    textSourceKind: null,
    ocrMeanConfidence: null,
    text: null,
    expectedPurposes: [],
    expectedFallbackStatus: 'unknown',
    expectedOrigins: [],
    valuablePersonal: true,
    expectedClutterCandidate: false
  },
  {
    id: 'doc-32-unsupported-spreadsheet',
    sliceCategory: 'honest_unknown',
    fileName: 'software_project_system_budget.xlsx',
    extension: '.xlsx',
    relativePath: 'Work/software_project_system_budget.xlsx',
    extractionStatus: 'unsupported',
    textSourceKind: null,
    ocrMeanConfidence: null,
    text: null,
    expectedPurposes: [],
    expectedFallbackStatus: 'unknown',
    expectedOrigins: [],
    valuablePersonal: true,
    expectedClutterCandidate: false
  }
]
