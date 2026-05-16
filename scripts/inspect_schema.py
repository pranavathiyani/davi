"""
DAVI - schema inspection.

One-shot. Reads the EvE parquet and prints what we need to know before
deciding final JSON shapes:
  - column dtypes and null counts
  - value counts for categorical fields
  - row counts per target class
  - actual contents of pxc50_modifier (undocumented)
  - mutant/wildtype counts
  - how many compound-target pairs have multiple rows (mode x mechanism)
  - viability assay coverage of 7TM

Run from project root:
    python scripts/inspect_schema.py
"""

import polars as pl
from pathlib import Path

PARQUET = Path(__file__).resolve().parent.parent / "data" / "raw" / "train.parquet"


def section(title: str) -> None:
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}")


def main() -> None:
    if not PARQUET.exists():
        raise SystemExit(f"Parquet not found at {PARQUET}")

    df = pl.read_parquet(PARQUET)

    section("Basic shape")
    print(f"Rows: {df.height:,}")
    print(f"Cols: {df.width}")
    print(f"File size on disk: {PARQUET.stat().st_size / 1e6:.2f} MB")

    section("Schema with dtypes")
    for name, dtype in df.schema.items():
        print(f"  {name:<32} {dtype}")

    section("Null counts (only columns with nulls shown)")
    nulls = df.null_count().row(0, named=True)
    for col, n in sorted(nulls.items(), key=lambda kv: -kv[1]):
        if n > 0:
            pct = 100 * n / df.height
            print(f"  {col:<32} {n:>10,}  ({pct:5.1f}%)")

    section("Target class distribution")
    print(df.group_by("target__class").len().sort("len", descending=True))

    section("Mode x target class")
    print(
        df.group_by(["target__class", "mode"])
        .len()
        .sort(["target__class", "len"], descending=[False, True])
    )

    section("assay__mechanism values per target class")
    print(
        df.group_by(["target__class", "assay__mechanism"])
        .len()
        .sort(["target__class", "len"], descending=[False, True])
    )

    section("assay__detailed_mechanism unique values (top 20)")
    print(
        df.group_by("assay__detailed_mechanism")
        .len()
        .sort("len", descending=True)
        .head(20)
    )

    section("assay__technology values")
    print(df.group_by("assay__technology").len().sort("len", descending=True))

    section("pxc50_modifier - undocumented field, need to see contents")
    print(df.group_by("pxc50_modifier").len().sort("len", descending=True))

    section("Activity / quantification summary")
    print(
        df.select(
            [
                pl.col("outcome_is_active").sum().alias("active_rows"),
                pl.col("is_quantified").sum().alias("quantified_rows"),
                pl.col("progressed").sum().alias("progressed_rows"),
                pl.col("viability_flag").sum().alias("viability_flagged"),
                pl.col("frequency_flag").sum().alias("frequency_flagged"),
            ]
        )
    )

    section("Active rows by class")
    print(
        df.filter(pl.col("outcome_is_active"))
        .group_by("target__class")
        .len()
        .sort("len", descending=True)
    )

    section("pXC50 distribution (active + quantified only)")
    pxc = df.filter(
        pl.col("outcome_is_active") & pl.col("is_quantified")
    ).select("outcome_potency_pxc50")
    print(pxc.describe())

    section("Unique counts")
    print(f"  compounds: {df['compound_id'].n_unique():,}")
    print(f"  targets:   {df['target_id'].n_unique():,}")
    print(f"  assays:    {df['assay_id'].n_unique():,}")
    print(f"  releases:  {df['release'].n_unique()}")

    section("Releases (so we know the snapshot)")
    print(df.group_by("release").len().sort("release"))

    section("Mutant vs wildtype kinases")
    print(
        df.filter(pl.col("target__class") == "Kinase")
        .group_by("target__is_mutant")
        .agg(pl.col("target_id").n_unique().alias("unique_targets"))
    )

    section("Wildtype-mutant linkage coverage")
    mutants = df.filter(
        (pl.col("target__class") == "Kinase") & pl.col("target__is_mutant")
    )
    if mutants.height > 0:
        n_mut_targets = mutants["target_id"].n_unique()
        n_with_wt = mutants.filter(
            pl.col("target__wildtype_id").is_not_null()
        )["target_id"].n_unique()
        print(f"  mutant targets total:           {n_mut_targets}")
        print(f"  mutant targets with wildtype_id: {n_with_wt}")

    section("Multiplicity: how many rows per (compound, target) pair?")
    multiplicity = (
        df.group_by(["compound_id", "target_id"])
        .len()
        .group_by("len")
        .len()
        .sort("len")
    )
    print(multiplicity)

    section("Multiplicity by target class")
    print(
        df.group_by(["target__class", "compound_id", "target_id"])
        .len()
        .group_by(["target__class", "len"])
        .len()
        .sort(["target__class", "len"])
    )

    section("Viability assay linkage")
    n_7tm = df.filter(pl.col("target__class") == "7TM").height
    n_7tm_with_vid = df.filter(
        (pl.col("target__class") == "7TM")
        & pl.col("viability_assay_id").is_not_null()
    ).height
    print(f"  7TM rows total:                  {n_7tm:,}")
    print(f"  7TM rows with viability_assay_id: {n_7tm_with_vid:,}")
    print(
        f"  unique viability assay IDs: "
        f"{df.filter(pl.col('target__class') == 'Viability')['assay_id'].n_unique()}"
    )

    section("Sample row (first active quantified row)")
    sample = df.filter(
        pl.col("outcome_is_active") & pl.col("is_quantified")
    ).head(1)
    for col in sample.columns:
        print(f"  {col:<32} {sample[col][0]}")


if __name__ == "__main__":
    main()
