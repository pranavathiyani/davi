# DAVI design notes

Captured during the v0.1 build. Future self: read this before second-guessing.

## Locked design decisions

1. **Landing page hero:** search box prominent at top, featured compound (Ponatinib, EB001170) as the default ego network. Compound chosen because it has 182 active targets - rich but not catastrophic, and the polypharmacology lesson (FDA-approved drug supposedly selective for BCR-ABL hits 180+ things) is instructive.

2. **pXC50 active threshold default:** 6.0. Slider range 5.0-9.0. The dataset quantifies pXC50 down to 5.0, but pharmacologically pXC50 < 6 is weak (~micromolar). Default of 6.0 keeps the landing graph readable; the slider exposes everything down to 5.0 for users who want it.

3. **Viability-flagged edges:** shown by default with dashed orange styling. Honest about the data: cytotoxicity confounds in 7TM cell-based assays should be visible, not hidden behind a toggle.

4. **First ego-network view to build:** compound-first. Polypharmacology is the dataset's main story.

5. **Data architecture:** local parquet -> Python build script -> six static JSONs -> GitHub Pages. No backend, no API at runtime. HF API rejected because (a) token can't be safely shipped in client JS, (b) access pattern is "load most data once, query in-browser" not "fetch one row at a time", (c) reproducibility requires a versioned snapshot.

## Additional decisions made during build

- **Edge collapsing in the network:** one visible edge per (compound, target), even when multiple mode/mechanism rows exist. Width = best (highest) pXC50. Side panel shows full granularity. Avoids parallel-edge visual noise.

- **Active-but-unquantified hits** (~32k of them) shipped as a separate `weak_hits.json`, surfaced in the side panel as a count and listed below quantified hits. Not drawn as edges to keep networks readable.

- **Wildtype self-references normalized to null** at build time. The schema sometimes has `wildtype_id == target_id` for non-mutants, which would render as a confusing self-link in the UI.

- **Three layout modes** (concentric-by-potency, spring, circular) with concentric-by-potency as default. Radial position encodes data (most potent inner, weakest outer). Spring is for exploration; circular is for clean illustration.

- **Drag-spring** implemented as a manual neighbor-propagation handler (15% delta propagation per drag frame), not via cola's `infinite: true`. The cytoscape-cola adapter's infinite mode is unreliable; the manual handler works across all three layouts.

- **JSON projection thresholds:** Jaccard >= 0.05, overlap >= 3 for both target-target and compound-compound projections. Keeps the projection files small (~350 KB and ~130 KB gzipped). Tunable via constants at the top of `build_jsons.py`.

## Things deliberately deferred to v0.2

- Mutant vs wildtype kinase overlay (12 mutants in current data, all with WT linkage available)
- Target-target and compound-compound projection views (data is built and shipped; UI views not yet implemented)
- "Updates Available" banner that checks HF API for new dataset releases
- Selectivity ranking view (compound vs all targets, sorted by selectivity window)

## Build cadence

EvE Bio refreshes the dataset bimonthly. To regenerate DAVI:

1. Re-download `train.parquet` from HuggingFace
2. Rerun `python scripts/build_jsons.py`
3. `git commit docs/data/` and push - GitHub Pages auto-deploys

The build script bakes the current release list into `build_info.json`, so the footer always shows the snapshot date.

## Naming history (for future puzzlement)

Final name DAVI (Drug-target Activity Viewer) was chosen after 30+ candidate names were searched against the bioinformatics tool namespace. Saturated acronym/name space in DT-* / DTA / DTI prediction tools forced the move to a spelled-out, friendly short name. The Tier-1 candidates we ruled out:

- DT-Net / DTNet: conflicts with deepDTnet (Cleveland Clinic) and the generic DTN concept
- DrugTargetExplorer: taken (Allaway et al., bioRxiv 2018)
- DrugTargetProfiler / DTP: taken (Tanoli et al., Brief Bioinform 2020)
- AffiNex: spelling-collision with Tecan AffinEx (trademarked antibody purification product)
- PolyPharmaNet: semantic confusion with polypharmacy (different concept) and adjacency to PPB (Awale & Reymond 2017)
- TDAP, DAE, DT-View: short forms collide with vaccines, oncology regimens, ML methods
- Greek/Roman/astronomy: namespace essentially closed (Orion, Hermes, Janus, Vega, Lyra, Circe, Iris all taken in bio)

DAVI was the cleanest landing zone: friendly, name-like, says exactly what the tool is.
