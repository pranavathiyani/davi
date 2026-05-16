"""
DAVI - build static JSONs from the EvE parquet.

Outputs to data/processed/:
  build_info.json        - snapshot date, release, dataset stats
  targets.json           - per-target summary
  compounds.json         - per-compound summary
  edges.json             - one entry per quantified-active row
  weak_hits.json         - active-but-not-quantified pairs (for side panel)
  target_target.json     - precomputed projection (Jaccard over shared compounds)
  compound_compound.json - precomputed projection (Jaccard over shared targets)
  search_index.json      - flat list for MiniSearch to ingest

Run from project root:
    python scripts/build_jsons.py
"""

from __future__ import annotations

import json
import gzip
from datetime import datetime, timezone
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parent.parent
PARQUET = ROOT / "data" / "raw" / "train.parquet"
OUT = ROOT / "data" / "processed"
DOCS_DATA = ROOT / "docs" / "data"

# Projection threshold: only include edges with Jaccard >= this value
# in the precomputed target-target and compound-compound projections.
# Keeps the JSONs small; users can recompute client-side from edges if needed.
PROJECTION_MIN_JACCARD = 0.05

# Minimum overlap (shared compounds for target-target, shared targets for
# compound-compound) before computing Jaccard. Filters out spurious 1-of-1 hits.
PROJECTION_MIN_OVERLAP = 3


def write_json(path: Path, obj, gzip_too: bool = True) -> None:
    """Write JSON, and a .gz alongside it for the browser."""
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    path.write_text(raw, encoding="utf-8")
    size_kb = path.stat().st_size / 1024
    print(f"  wrote {path.name:<28} {size_kb:>10,.1f} KB", end="")
    if gzip_too:
        gz_path = path.with_suffix(path.suffix + ".gz")
        with gzip.open(gz_path, "wt", encoding="utf-8") as f:
            f.write(raw)
        gz_kb = gz_path.stat().st_size / 1024
        print(f"   ({gz_kb:,.1f} KB gz)")
    else:
        print()


def section(title: str) -> None:
    print(f"\n[{title}]")


def main() -> None:
    if not PARQUET.exists():
        raise SystemExit(f"Parquet not found at {PARQUET}")

    OUT.mkdir(parents=True, exist_ok=True)

    section("Loading parquet")
    df_all = pl.read_parquet(PARQUET)
    print(f"  rows: {df_all.height:,}")

    # Split: viability rows have null target__class
    viability = df_all.filter(pl.col("target__class").is_null())
    df = df_all.filter(pl.col("target__class").is_not_null())
    print(f"  target rows:    {df.height:,}")
    print(f"  viability rows: {viability.height:,}")

    # Edges: active and quantified
    edges_df = df.filter(
        pl.col("outcome_is_active") & pl.col("is_quantified")
    )
    print(f"  edges (active + quantified): {edges_df.height:,}")

    # Weak hits: active but not quantified (out-of-range potency)
    weak_df = df.filter(
        pl.col("outcome_is_active") & ~pl.col("is_quantified")
    )
    print(f"  weak hits (active, unquantified): {weak_df.height:,}")

    # ------------------------------------------------------------------
    # build_info
    # ------------------------------------------------------------------
    section("Building build_info.json")
    releases = sorted(
        [r for r in df["release"].unique().to_list() if r is not None],
        key=lambda x: (len(x), x),
    )
    build_info = {
        "build_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "build_time_utc": datetime.now(timezone.utc).isoformat(),
        "dataset": "eve-bio/drug-target-activity",
        "dataset_url": "https://huggingface.co/datasets/eve-bio/drug-target-activity",
        "releases_included": releases,
        "latest_release": releases[-1] if releases else None,
        "stats": {
            "total_rows": int(df_all.height),
            "target_rows": int(df.height),
            "viability_rows": int(viability.height),
            "n_compounds": int(df["compound_id"].n_unique()),
            "n_targets": int(df["target_id"].n_unique()),
            "n_edges_quantified": int(edges_df.height),
            "n_weak_hits": int(weak_df.height),
        },
    }
    write_json(OUT / "build_info.json", build_info, gzip_too=False)

    # ------------------------------------------------------------------
    # compounds.json
    # ------------------------------------------------------------------
    section("Building compounds.json")
    # Per-compound summary stats from edges (quantified actives only)
    compound_stats = (
        edges_df.group_by("compound_id")
        .agg(
            [
                pl.col("target_id").n_unique().alias("n_active_targets"),
                pl.col("outcome_potency_pxc50").max().alias("max_pxc50"),
                pl.col("outcome_potency_pxc50").mean().alias("mean_pxc50"),
            ]
        )
    )

    # Static compound metadata - one row per compound (deduplicated)
    compound_meta = (
        df.group_by("compound_id")
        .agg(
            [
                pl.col("compound__name").first().alias("name"),
                pl.col("compound__smiles").first().alias("smiles"),
                pl.col("compound__drugbank_id").first().alias("drugbank"),
                pl.col("compound__cas").first().alias("cas"),
                pl.col("compound__unii").first().alias("unii"),
                pl.col("compound__inchikey").first().alias("inchikey"),
            ]
        )
    )

    compounds = (
        compound_meta.join(compound_stats, on="compound_id", how="left")
        .with_columns(
            [
                pl.col("n_active_targets").fill_null(0),
            ]
        )
        .sort("name")
    )

    compounds_list = []
    for row in compounds.iter_rows(named=True):
        compounds_list.append(
            {
                "id": row["compound_id"],
                "name": row["name"],
                "smiles": row["smiles"],
                "drugbank": row["drugbank"],
                "cas": row["cas"],
                "unii": row["unii"],
                "inchikey": row["inchikey"],
                "n_targets": int(row["n_active_targets"]),
                "max_pxc50": (
                    round(row["max_pxc50"], 2)
                    if row["max_pxc50"] is not None
                    else None
                ),
                "mean_pxc50": (
                    round(row["mean_pxc50"], 2)
                    if row["mean_pxc50"] is not None
                    else None
                ),
            }
        )
    print(f"  compounds: {len(compounds_list):,}")
    write_json(OUT / "compounds.json", compounds_list)

    # ------------------------------------------------------------------
    # targets.json
    # ------------------------------------------------------------------
    section("Building targets.json")
    target_stats = (
        edges_df.group_by("target_id")
        .agg(
            [
                pl.col("compound_id").n_unique().alias("n_active_compounds"),
                pl.col("outcome_potency_pxc50").max().alias("max_pxc50"),
                pl.col("outcome_potency_pxc50").mean().alias("mean_pxc50"),
            ]
        )
    )

    target_meta = (
        df.group_by("target_id")
        .agg(
            [
                pl.col("target__class").first().alias("target_class"),
                pl.col("target__gene").first().alias("gene"),
                pl.col("target__uniprot_id").first().alias("uniprot"),
                pl.col("target__name").first().alias("name"),
                pl.col("target__is_mutant").first().alias("is_mutant"),
                pl.col("target__wildtype_id").first().alias("wildtype_id"),
            ]
        )
    )

    targets = (
        target_meta.join(target_stats, on="target_id", how="left")
        .with_columns([pl.col("n_active_compounds").fill_null(0)])
        .sort(["target_class", "gene"])
    )

    targets_list = []
    for row in targets.iter_rows(named=True):
        # wildtype_id == target_id means "this is wildtype" - normalize that
        # to null so the frontend doesn't show a confusing self-link
        wt = row["wildtype_id"]
        if wt == row["target_id"]:
            wt = None
        targets_list.append(
            {
                "id": row["target_id"],
                "gene": row["gene"],
                "name": row["name"],
                "uniprot": row["uniprot"],
                "class": row["target_class"],
                "is_mutant": bool(row["is_mutant"]),
                "wildtype_id": wt,
                "n_compounds": int(row["n_active_compounds"]),
                "max_pxc50": (
                    round(row["max_pxc50"], 2)
                    if row["max_pxc50"] is not None
                    else None
                ),
                "mean_pxc50": (
                    round(row["mean_pxc50"], 2)
                    if row["mean_pxc50"] is not None
                    else None
                ),
            }
        )
    print(f"  targets: {len(targets_list):,}")
    write_json(OUT / "targets.json", targets_list)

    # ------------------------------------------------------------------
    # edges.json - one entry per quantified-active row
    # ------------------------------------------------------------------
    section("Building edges.json")
    # Join viability info onto 7TM edges
    # Viability assay has compound_id and assay_id; we join to 7TM
    # edges via (viability_assay_id, compound_id) -> (assay_id, compound_id)
    viability_lookup = viability.select(
        [
            pl.col("assay_id"),
            pl.col("compound_id"),
            pl.col("outcome_potency_pxc50").alias("viab_pxc50"),
            pl.col("outcome_is_active").alias("viab_active"),
        ]
    )

    edges_joined = edges_df.join(
        viability_lookup,
        left_on=["viability_assay_id", "compound_id"],
        right_on=["assay_id", "compound_id"],
        how="left",
    )

    edges_list = []
    for row in edges_joined.iter_rows(named=True):
        edges_list.append(
            {
                "c": row["compound_id"],
                "t": row["target_id"],
                "mode": row["mode"],
                "mech": row["assay__mechanism"],
                "dmech": row["assay__detailed_mechanism"],
                "pxc50": round(row["outcome_potency_pxc50"], 2),
                "max_act": (
                    round(row["outcome_max_activity"], 1)
                    if row["outcome_max_activity"] is not None
                    else None
                ),
                "viab_flag": bool(row["viability_flag"]),
                "freq_flag": bool(row["frequency_flag"]),
                "viab_pxc50": (
                    round(row["viab_pxc50"], 2)
                    if row["viab_pxc50"] is not None
                    else None
                ),
            }
        )
    print(f"  edges: {len(edges_list):,}")
    write_json(OUT / "edges.json", edges_list)

    # ------------------------------------------------------------------
    # weak_hits.json
    # ------------------------------------------------------------------
    section("Building weak_hits.json")
    weak_list = []
    for row in weak_df.iter_rows(named=True):
        weak_list.append(
            {
                "c": row["compound_id"],
                "t": row["target_id"],
                "mode": row["mode"],
                "mech": row["assay__mechanism"],
                "max_act": (
                    round(row["outcome_max_activity"], 1)
                    if row["outcome_max_activity"] is not None
                    else None
                ),
                "viab_flag": bool(row["viability_flag"]),
                "freq_flag": bool(row["frequency_flag"]),
            }
        )
    print(f"  weak hits: {len(weak_list):,}")
    write_json(OUT / "weak_hits.json", weak_list)

    # ------------------------------------------------------------------
    # target_target.json - Jaccard projection over shared active compounds
    # ------------------------------------------------------------------
    section("Building target_target.json")
    # Build per-target compound sets
    target_compounds = {
        row["target_id"]: set(row["compounds"])
        for row in edges_df.group_by("target_id")
        .agg(pl.col("compound_id").unique().alias("compounds"))
        .iter_rows(named=True)
    }
    target_ids = sorted(target_compounds.keys())
    tt_edges = []
    for i, t1 in enumerate(target_ids):
        s1 = target_compounds[t1]
        if len(s1) < PROJECTION_MIN_OVERLAP:
            continue
        for t2 in target_ids[i + 1 :]:
            s2 = target_compounds[t2]
            if len(s2) < PROJECTION_MIN_OVERLAP:
                continue
            overlap = len(s1 & s2)
            if overlap < PROJECTION_MIN_OVERLAP:
                continue
            jaccard = overlap / len(s1 | s2)
            if jaccard >= PROJECTION_MIN_JACCARD:
                tt_edges.append(
                    {
                        "a": t1,
                        "b": t2,
                        "j": round(jaccard, 3),
                        "n": overlap,
                    }
                )
    print(f"  target-target edges (jaccard >= {PROJECTION_MIN_JACCARD}): {len(tt_edges):,}")
    write_json(OUT / "target_target.json", tt_edges)

    # ------------------------------------------------------------------
    # compound_compound.json - Jaccard over shared targets
    # ------------------------------------------------------------------
    section("Building compound_compound.json")
    compound_targets = {
        row["compound_id"]: set(row["targets"])
        for row in edges_df.group_by("compound_id")
        .agg(pl.col("target_id").unique().alias("targets"))
        .iter_rows(named=True)
    }
    compound_ids = sorted(compound_targets.keys())
    cc_edges = []
    for i, c1 in enumerate(compound_ids):
        s1 = compound_targets[c1]
        if len(s1) < PROJECTION_MIN_OVERLAP:
            continue
        for c2 in compound_ids[i + 1 :]:
            s2 = compound_targets[c2]
            if len(s2) < PROJECTION_MIN_OVERLAP:
                continue
            overlap = len(s1 & s2)
            if overlap < PROJECTION_MIN_OVERLAP:
                continue
            jaccard = overlap / len(s1 | s2)
            if jaccard >= PROJECTION_MIN_JACCARD:
                cc_edges.append(
                    {
                        "a": c1,
                        "b": c2,
                        "j": round(jaccard, 3),
                        "n": overlap,
                    }
                )
    print(f"  compound-compound edges (jaccard >= {PROJECTION_MIN_JACCARD}): {len(cc_edges):,}")
    write_json(OUT / "compound_compound.json", cc_edges)

    # ------------------------------------------------------------------
    # search_index.json - flat list, MiniSearch ingests on the client
    # ------------------------------------------------------------------
    section("Building search_index.json")
    search_docs = []
    for t in targets_list:
        search_docs.append(
            {
                "id": t["id"],
                "type": "target",
                "label": t["gene"] or t["id"],
                "name": t["name"],
                "uniprot": t["uniprot"],
                "class": t["class"],
                "n_compounds": t["n_compounds"],
            }
        )
    for c in compounds_list:
        search_docs.append(
            {
                "id": c["id"],
                "type": "compound",
                "label": c["name"] or c["id"],
                "drugbank": c["drugbank"],
                "cas": c["cas"],
                "n_targets": c["n_targets"],
            }
        )
    print(f"  search docs: {len(search_docs):,}")
    write_json(OUT / "search_index.json", search_docs)

    # ------------------------------------------------------------------
    # Copy/link processed JSONs into docs/data for GitHub Pages
    # ------------------------------------------------------------------
    section("Copying processed JSONs to docs/data/")
    DOCS_DATA.mkdir(parents=True, exist_ok=True)
    for f in OUT.iterdir():
        if f.is_file():
            dest = DOCS_DATA / f.name
            dest.write_bytes(f.read_bytes())
    print(f"  copied {len(list(DOCS_DATA.iterdir()))} files to docs/data/")

    section("Done")
    print(f"  outputs in: {OUT}")
    print(f"  also at:    {DOCS_DATA}")


if __name__ == "__main__":
    main()
