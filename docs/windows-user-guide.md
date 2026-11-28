# Personal Vault on Windows

## Install and get started

1. Use the verified Windows x64 NSIS installer (`Personal Vault Setup 0.1.0.exe`). Close Personal Vault before installing an update manually; installers preserve your `%APPDATA%\Personal Vault` profile (`vault-catalog.db`) and external vault folder. For updater-enabled builds, see [Windows app updates](windows-release-pipeline.md).
2. Open Personal Vault, go to **All Items**, and select **Select Source Folders**. Start with a small folder you know well. **Start Scan** adds files to the catalog and reads their metadata and contents without changing the originals.
3. To keep a verified copy inside the vault, open **Review**, choose a dedicated vault folder, and initialize it. Select the files you want and run **Start Verified Import**. A scanned item can appear in the catalog before it has a vault copy.
4. To use offline semantic search or OCR, set up the corresponding models in the app. Model downloads require an internet connection. Once installed, indexing, OCR, and searches run locally.

Personal Vault 0.1.0 is scoped for personal Windows x64 desktop use. Public distribution, Authenticode/SmartScreen signing, and macOS/Linux installers are outside the current scope. Clean Windows x64 Sandbox verification and isolated-`appId` upgrade/migration/uninstall checks have passed; the tested uninstall flow preserves the profile and vault. Keep a verified backup before upgrading or uninstalling, and keep the vault folder outside the application installation directory.

## Privacy

- Scanning, thumbnails, indexing, OCR, and classification process files locally. Keep control of where you store the catalog, vault, and exported bundles.
- The catalog records source paths and file information. Ratings, flags, collections, and other review data can also be included in a backup. Treat backup repositories and exported files as private, especially when storing them on shared drives.
- Network access can occur when you explicitly download a model or connect and use Google Drive for backup. Google Drive is optional. The internal build requires Desktop OAuth configuration supplied to the app at launch. Use a dedicated Drive folder for Personal Vault backups.

## Back up and check recovery

1. Open **Backup & Restore**. Choose a local folder on any available drive, a USB drive, a NAS/network folder, or an encrypted Google Drive destination. Save the destination. Keep it separate from your active vault and source folders so one storage failure cannot affect both, and avoid overlapping folders.
2. Review the pre-backup summary before starting: confirm the receiving folder, how many imported vault files will be backed up (and how many scanned-only files outside the vault are excluded), and the approximate backup size. If 0 files are in the vault yet, Personal Vault warns before starting that the backup will save catalog and annotations only.
3. For Google Drive, connect your account, choose a dedicated folder, and enter an encryption recovery secret. Store the secret in a password manager or another secure place you can still access after losing this PC. You need it to unlock the backup. If the only copy of the secret is lost, the encrypted backup cannot be restored.
4. Select **Back up now**, wait for completion, and select **Verify backup**. For an encrypted snapshot, provide the recovery secret again when needed. A locked snapshot can show an unavailable file count until it is unlocked.
5. Run a recovery drill. In **Restore Files**, select the recovery point and provide a new or empty destination folder. Enter the recovery secret if required, then select **Restore files**. The app restores a separate profile and creates a vault subfolder when the snapshot contains a vault. Open a few restored files and confirm they are the expected copies.

Backups include the catalog, annotations, and imported vault files. Scanned files outside the vault remain in their original folders, so back those folders up separately. Thumbnails and offline AI models are excluded and can be recreated or installed again.

If you have the vault folder but have lost the catalog, **Recover from an existing vault** can rebuild a catalog of imported files from its manifests. It gives you read-only access to those files (new vault imports into a recovered vault are refused). In a recovered profile, thumbnails, photo metadata extraction, semantic indexing, document text extraction, and offline OCR all work against the verified vault copies. Use **Restore Files** with a backup when you need ratings, collections, review decisions, and other saved edits.

For issues, record the app version, operation, and exact error, and report them via the repository (`Inouye165/personal-vault`) or `docs/stage-8d-trial-checklist.md`. Use a disposable example where possible and keep recovery secrets, OAuth credentials, tokens, and private files out of reports.
