# Synthetic HEIC Test Fixtures

These three files are redistributable synthetic HEIC/HEIF fixtures generated locally from scratch (no personal photographs or third-party assets):

- `landscape.heic` (418 bytes): Minimal `ftypheic` ISOBMFF container carrying a valid 160x100 single-color HEVC intra bitstream with no EXIF metadata (`extractionStatus: 'no_metadata'`).
- `portrait_exif6.heic` (693 bytes): Synthetic 160x100 HEVC intra bitstream wrapped in an `ftypheic` ISOBMFF container with an HEIF `irot` (`270` degrees) property (producing 100x160 oriented display pixels in `libheif`/`sharp`) plus an embedded synthetic EXIF `Exif` item (`Make: Apple`, `Model: iPhone 15 Pro Max`, `LensModel: iPhone 15 Pro Max back triple camera 6.765mm f/1.78`, `Orientation: 6`, `DateTimeOriginal: 2024:04:21 09:22:06`, `OffsetTimeOriginal: -10:00`) for testing non-double-rotated decoding and metadata extraction.
- `sunset_heic.heic` (1,149 bytes): Synthetic 256x256 warm-orange gradient HEVC intra bitstream in an `ftypheic` ISOBMFF container for testing CLIP 224x224 semantic preprocessing, perceptual `dhash64_v1` fingerprinting, and semantic search indexing.
