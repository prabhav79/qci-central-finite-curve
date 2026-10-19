"""
Search-quality evaluation: runs a fixed gold set through db_search in three
modes (legacy ranking, hybrid, hybrid + Jev re-rank) and reports hit@5, MRR,
distinct documents in the top 5 and latency.

Run from apps/api (local SQLite or any DATABASE_URL):
    python scripts/eval_search.py [--user 6281] [--modes legacy,hybrid,jev] [--show 3]
"""
from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

GOLD: list[dict] = [
    # The three demo briefs.
    {"q": "Proposal for third-party evaluation of the centrally sponsored schemes of the Department of Fisheries, "
          "Ministry of Fisheries, Animal Husbandry & Dairying, with a nationwide field survey, beneficiary sampling "
          "and a final evaluation report.",
     "expect": ["QCI Proposal for Third-Party Evaluation of LHDCP and SDC&FPO Schemes of DAHD (1)",
                "QCI Revised Proposal for NPDD Scheme Evaluation_With QCI's Experience",
                "QCI's Proposal for Third Party Evaluation of Scheme I  II of NHB for FY 2019-2024 (004)",
                "QCI_MoC_Proposal_for_Third_Party_Evaluation_of_CSS_MOC_v11_vF_13.06.2025-1 (3)",
                "QCI_Proposal_for_Third Party_Evaluation_of_DPPH Scheme"],
     "demo": True},
    {"q": "State-wide third-party cleanliness and sanitation assessment of government schools across all districts "
          "of Gujarat, with geo-tagged field audits, a scoring framework and district-wise rankings.",
     "expect": ["Proposal for Hospitals Assessment in Gujarat", "Proposal - Swachh Tripura V2", "QCI_PeyJal Proposal",
                "Proposal_GSRTC 2026", "Nashik_proposal 25-08-2025"],
     "demo": True},
    {"q": "Impact assessment of PM Surya Ghar Muft Bijli Yojana rooftop solar installations across Rajasthan, with a "
          "household beneficiary survey, discom data analysis and an impact report.",
     "expect": ["PM_SGMBY_141024_Proposal"],
     "demo": True},
    # Topic lookups.
    {"q": "project management unit for grievance redressal on CPGRAMS for a state government",
     "expect": ["Proposal CPGRAMS PMU-QCI_DARPG_29082024_old", "1st Work Order_CPGRAMS PMU_DARPG_14072022",
                "8th Work Order_CPGRAMS PMU_DARPG_25032026", "7th Work Order_CPGRAMS PMU_DARPG_21102025"]},
    {"q": "Special Campaign for disposal of pending matters and cleanliness in government offices",
     "expect": ["Extension Proposal for SCDPM PMU-QCI_DARPG_30092024", "7th Work Order_SCDPM PMU_DARPG_28032024",
                "6th Work Order_SCDPM PMU_DARPG_04112024"]},
    {"q": "National e-Governance Service Delivery Assessment of state portals",
     "expect": ["1st Work Order_NeSDA PMU_DARPG_07022023", "2nd Work Order_NeSDA PMU_DARPG_07022024",
                "3rd Work Order_NeSDA PMU_DARPG_01042024", "4th Work Order_NeSDA PMU_DARPG_08042025"]},
    {"q": "impact assessment of credit linked subsidy scheme under PMAY urban housing",
     "expect": ["Proposal_PMAYU_Impact Assessment of CLSS_14.03.24"]},
    {"q": "evaluation of PM SVANidhi support for street vendors",
     "expect": ["PM-SVANidhi Se Samriddhi (2025-26)_QCI_Proposal_with Annexure_04082025"]},
    {"q": "evaluation of the national pension scheme for traders and self-employed persons",
     "expect": ["NPS Proposal_MoLE_Final (2)"]},
    {"q": "floriculture mission evaluation for CSIR",
     "expect": ["CSIR - Floriculture Proposal"]},
    {"q": "third-party monitoring of forest plantations for the Gujarat Forest Department",
     "expect": ["Revised Proposal for TPME of Forest Plantation by GFD"]},
    {"q": "farmer awareness programme on warehouse receipts for the warehousing regulator",
     "expect": ["WDRA_QCI Proposal_23062025"]},
    {"q": "monitoring of drain desilting works in Delhi",
     "expect": ["Draft QCI Proposal Delhi Drain Desilting Monitoring 25-02-2026"]},
    {"q": "cleanliness and housekeeping assessment of bus stations and depots",
     "expect": ["Proposal_GSRTC 2026"]},
    {"q": "drinking water service survey for a municipal corporation",
     "expect": ["QCI_PeyJal Proposal"]},
    {"q": "village development through gram panchayat capacity building",
     "expect": ["20240219_VSTF Proposal_vF"]},
    {"q": "evaluation of centrally sponsored schemes of the Ministry of Culture",
     "expect": ["QCI_MoC_Proposal_for_Third_Party_Evaluation_of_CSS_MOC_v11_vF_13.06.2025-1 (3)"]},
    {"q": "conference management PMU with IIAS for DARPG",
     "expect": ["1st Work Order_IIAS-DARPG Conference PMU_13122024", "2nd Work Order_IIAS-DARPG Conference PMU_03042025"]},
    # Section-specific queries (what the generator issues).
    {"q": "payment schedule mobilisation advance and percentage on submission of inception and final evaluation report",
     "section": "payment_milestones",
     "expect": ["CSIR - Floriculture Proposal", "NPS Proposal_MoLE_Final (2)",
                "QCI Proposal for Third-Party Evaluation of LHDCP and SDC&FPO Schemes of DAHD (1)",
                "Revised Proposal for TPME of Forest Plantation by GFD", "WDRA_QCI Proposal_23062025",
                "QCI_PeyJal Proposal", "Work Order_Anubhav Initiative_DoPPW_09122025"]},
    {"q": "deliverables inception report draft evaluation report final report for a scheme evaluation",
     "section": "deliverables",
     "expect": ["QCI Proposal for Third-Party Evaluation of LHDCP and SDC&FPO Schemes of DAHD (1)",
                "QCI Revised Proposal for NPDD Scheme Evaluation_With QCI's Experience",
                "QCI's Proposal for Third Party Evaluation of Scheme I  II of NHB for FY 2019-2024 (004)",
                "QCI_MoC_Proposal_for_Third_Party_Evaluation_of_CSS_MOC_v11_vF_13.06.2025-1 (3)",
                "QCI_Proposal_for_Third Party_Evaluation_of_DPPH Scheme"]},
    {"q": "team composition with team leader, domain experts and field investigators for a sanitation assessment",
     "section": "composition_manpower",
     "expect": ["Proposal for Hospitals Assessment in Gujarat", "Proposal - Swachh Tripura V2", "QCI_PeyJal Proposal",
                "Draft QCI Proposal Delhi Drain Desilting Monitoring 25-02-2026", "Nashik_proposal 25-08-2025",
                "Proposal_GSRTC 2026"]},
    {"q": "social media and communications PMU for DARPG",
     "expect": ["Work Order_Media PMU_DARPG_08012025"]},
    # Negatives: nothing in the corpus is relevant.
    {"q": "recipe for butter chicken", "expect": [], "negative": True},
    {"q": "cricket world cup schedule", "expect": [], "negative": True},
]

MODES = {
    "legacy": {"CFC_SEARCH_MODE": "legacy", "CFC_JEV_RERANK": "0"},
    "hybrid": {"CFC_SEARCH_MODE": "hybrid", "CFC_JEV_RERANK": "0"},
    "jev": {"CFC_SEARCH_MODE": "hybrid", "CFC_JEV_RERANK": "1"},
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default="6281")
    ap.add_argument("--modes", default="legacy,hybrid,jev")
    ap.add_argument("--show", type=int, default=0, help="print the top-N docs for demo queries")
    args = ap.parse_args()

    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[3] / ".env")
    from app.corpus_db import db_search
    from app.db import SessionLocal
    from app.models import User

    with SessionLocal() as s:
        user = s.get(User, args.user)
        if user is None:
            sys.exit(f"unknown user {args.user}")
        db_search(s, "warm up", user=user, limit=1)  # load the embedding model outside the timings

        for mode in args.modes.split(","):
            os.environ.update(MODES[mode])
            hits5, rrs, distinct, lat, neg_top = [], [], [], [], []
            print(f"\n=== {mode} ===")
            for g in GOLD:
                t0 = time.perf_counter()
                res = db_search(s, g["q"], user=user, limit=5, section=g.get("section"))
                lat.append(time.perf_counter() - t0)
                docs = [h["doc_id"] for h in res]
                if g.get("negative"):
                    top_rel = max((h.get("relevance", 0.0) for h in res), default=0.0)
                    neg_top.append(top_rel)
                    print(f"  NEG  top-relevance={top_rel:.2f}  {g['q'][:60]}")
                    continue
                expect = set(g["expect"])
                rank = next((i + 1 for i, d in enumerate(docs) if d in expect), None)
                hits5.append(1 if rank else 0)
                rrs.append(1 / rank if rank else 0.0)
                distinct.append(len(set(docs)))
                flag = "ok " if rank else "MISS"
                print(f"  {flag} rank={rank or '-'} distinct={len(set(docs))} {g['q'][:70]}")
                if args.show and g.get("demo"):
                    for h in res[: args.show]:
                        print(f"        - {h['doc_id'][:70]}  rel={h.get('relevance', '-')}  sec={h.get('section_label')}")
            p50 = statistics.median(lat)
            p95 = sorted(lat)[max(0, int(len(lat) * 0.95) - 1)]
            print(
                f"  -> hit@5={sum(hits5)}/{len(hits5)}  MRR={statistics.mean(rrs):.3f}  "
                f"distinct-docs@5={statistics.mean(distinct):.1f}  latency p50={p50 * 1000:.0f}ms p95={p95 * 1000:.0f}ms"
                + (f"  negatives max-relevance={max(neg_top):.2f}" if neg_top else "")
            )


if __name__ == "__main__":
    main()
