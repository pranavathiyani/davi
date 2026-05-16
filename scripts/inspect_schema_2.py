"""
DAVI - schema inspection, part 2.

Reruns the multiplicity check that crashed (polars column name collision)
plus two follow-ups now that we know the basic shape.
"""

import polars as pl
from pathlib import Path

PARQUET = Path(__file__).resolve().parent.parent / "data" / "raw" / "train.parquet"


def section(title: str) -> None:
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}")


def main() -> None:
    df = pl.read_parquet(PARQUET)

    # Drop rows with null target__class (those are viability rows handled separately)
    df_tgt = df.filter(pl.col("target__class").is_not_null())

    section("Multiplicity: rows per (compound, target) pair, all classes")
    per_pair = (
        df_tgt.group_by(["compound_id", "target_id"])
        .agg(pl.len().alias("row_count"))
    )
    print(
        per_pair.group_by("row_count")
        .agg(pl.len().alias("n_pairs"))
        .sort("row_count")
    )

    section("Multiplicity by target class")
    per_pair_cls = (
        df_tgt.group_by(["target__class", "compound_id", "target_id"])
        .agg(pl.len().alias("row_count"))
    )
    print(
        per_pair_cls.group_by(["target__class", "row_count"])
        .agg(pl.len().alias("n_pairs"))
        .sort(["target__class", "row_count"])
    )

    section("Viability assay linkage")
    n_7tm = df.filter(pl.col("target__class") == "7TM").height
    n_7tm_with_vid = df.filter(
        (pl.col("target__class") == "7TM")
        & pl.col("viability_assay_id").is_not_null()
    ).height
    n_viab_assays = df.filter(
        pl.col("target__class").is_null()
    )["assay_id"].n_unique()
    print(f"  7TM rows total:                   {n_7tm:,}")
    print(f"  7TM rows with viability_assay_id: {n_7tm_with_vid:,}")
    print(f"  unique viability assay IDs:       {n_viab_assays}")

    section("Sample row: first active+quantified")
    sample = df.filter(
        pl.col("outcome_is_active") & pl.col("is_quantified")
    ).head(1)
    for col in sample.columns:
        print(f"  {col:<32} {sample[col][0]}")

    section("Active+quantified edge count by class (the network edges)")
    print(
        df_tgt.filter(pl.col("outcome_is_active") & pl.col("is_quantified"))
        .group_by("target__class")
        .agg(pl.len().alias("n_edges"))
        .sort("n_edges", descending=True)
    )

    section("Unique (compound,target) ACTIVE pairs per class")
    print(
        df_tgt.filter(pl.col("outcome_is_active") & pl.col("is_quantified"))
        .group_by("target__class")
        .agg(
            pl.struct(["compound_id", "target_id"])
            .n_unique()
            .alias("unique_pairs")
        )
        .sort("unique_pairs", descending=True)
    )

    section("Per-target hit count (top 20 most-hit targets)")
    print(
        df_tgt.filter(pl.col("outcome_is_active") & pl.col("is_quantified"))
        .group_by(["target__gene", "target__class"])
        .agg(pl.col("compound_id").n_unique().alias("n_active_compounds"))
        .sort("n_active_compounds", descending=True)
        .head(20)
    )

    section("Per-compound hit count (top 20 most-promiscuous compounds)")
    print(
        df_tgt.filter(pl.col("outcome_is_active") & pl.col("is_quantified"))
        .group_by(["compound__name", "compound_id"])
        .agg(pl.col("target_id").n_unique().alias("n_active_targets"))
        .sort("n_active_targets", descending=True)
        .head(20)
    )


if __name__ == "__main__":
    main()
