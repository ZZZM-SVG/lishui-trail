# Third-Party Notices / 第三方组件与数据声明

The MIT license in [`LICENSE`](LICENSE) covers this repository's own source code only.
The components and data below keep their own terms and are **not** relicensed by it.

本仓库的 MIT 许可证（[`LICENSE`](LICENSE)）仅覆盖本项目自有源码。下列组件与数据各自保留原有条款，不被该许可证重新授权。

---

## 1. AgnesHarness (AGH)

- **Used for**: agent runtime and execution foundation (tool registration, trust model, session replay).
- **Terms**: AGH is not vendored in this repository — it is built and installed separately from its public upstream source. The upstream project's own `LICENSE` and `NOTICE` apply to it.
- **In this repo**: only the plugin side (`packages/lishui-trail-plugin/`) is ours; it consumes AGH's public plugin API.

## 2. OpenStreetMap — road network & water bodies

- **Used for**: trail network and water-body grids baked into `data/`.
- **Attribution**: © OpenStreetMap contributors.
- **License**: Open Database License (ODbL) 1.0 — <https://www.openstreetmap.org/copyright>
- **Note**: derived databases in `data/` remain subject to ODbL share-alike terms.

## 3. Elevation data — AWS Open Data Terrain Tiles

- **Used for**: digital elevation model, baked to a 30 m metric square grid (2149 × 1511, int16).
- **Source**: AWS Open Data Terrain Tiles (Mapzen terrarium encoding, SRTM-derived), used under the Registry of Open Data on AWS terms.
- **Note**: SRTM 1″ native resolution is ≈30 m, which is the true information limit of elevation in this area; no finer interpolation is claimed.

## 4. Tourism resource table (Lishui–Bowang)

- **Used for**: tourism dataset source (162 anchor points across 8 towns).
- **Rights**: provided by the competition organizers; **copyright remains with the original provider**.
- **Redistribution**: the original `.xlsx` is **not** redistributed in this public repository. Only rule-derived data (`data/pois.json`) is published, with the source file's SHA-256 recorded in `data/checksums.json` for provenance.

---

## 5. Fonts and visual assets

- All diagrams, screenshots and evidence images in `docs/` were produced by the team for this project.
- No third-party icon sets, fonts, or stock imagery are redistributed in this repository.

If you believe any material here is attributed incorrectly, please open an issue and it will be corrected.
