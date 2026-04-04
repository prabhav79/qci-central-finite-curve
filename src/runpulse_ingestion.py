"""
QCI Central Finite Curve — RunPulse Ingestion Pipeline
=======================================================
Replaces: Google Vertex AI (Gemini), Google Cloud Vision, EasyOCR
Provider:  RunPulse (https://runpulse.com) — SOC 2 compliant, zero data retention

Verified RunPulse SDK pattern (pulse-python-sdk):
  Step 1. client.extract(file=f)        → ExtractResponse.extraction_id
  Step 2. client.schema(extraction_id,  → SingleSchemaResponse.schema_output.values
          schema_config={input_schema})

Usage (run from project root):
  python src/runpulse_ingestion.py
"""

import os
import glob
import json
import time
import traceback
import logging
from pathlib import Path
from typing import Optional

from pulse import Pulse
from dotenv import load_dotenv

import sys
sys.path.insert(0, os.path.dirname(__file__))

from models import (
    WorkOrderDocument,
    WorkOrderMeta,
    WorkOrderContent,
    TableData,
    GraphNode,
)
from utils import save_json

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
load_dotenv()

RUNPULSE_API_KEY = os.getenv("RUNPULSE_API_KEY")
if not RUNPULSE_API_KEY:
    raise EnvironmentError(
        "RUNPULSE_API_KEY not set.\n"
        "  → Locally: add to .env file\n"
        "  → Streamlit Cloud: add to Secrets panel"
    )

SOURCE_DIR    = "Work Orders"
PROCESSED_DIR = "data/processed"
RATE_LIMIT_SLEEP = 1  # seconds between documents

# ---------------------------------------------------------------------------
# QCI Work Order extraction schema
# ---------------------------------------------------------------------------
WORK_ORDER_SCHEMA = {
    "type": "object",
    "properties": {
        "ministry": {
            "type": "string",
            "description": (
                "Full name of the Indian Government Ministry or Department that "
                "issued this work order. E.g. 'Ministry of Personnel, PG and Pensions, "
                "Deptt. of Administrative Reforms and Public Grievances'."
            ),
        },
        "date": {
            "type": "string",
            "description": "Date the work order was issued, formatted as YYYY-MM-DD.",
        },
        "value_inr": {
            "type": "number",
            "description": (
                "Total monetary value of the work order in Indian Rupees as a plain number. "
                "No commas, no currency symbols. E.g. 6552000 for Rs. 65,52,000/-."
            ),
        },
        "domains": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "2–5 topic tags for this work order's subject area. "
                "E.g. ['Grievance Redressal', 'PMU Support', 'Digital Governance', 'e-Governance']."
            ),
        },
        "project_subject": {
            "type": "string",
            "description": (
                "The specific subject or title of this project as stated in the document. "
                "E.g. 'Setting up PMU for CPGRAMS with 3 resource persons for one year'."
            ),
        },
        "deliverables": {
            "type": "string",
            "description": (
                "Plain-text summary (under 400 words) of key deliverables, scope of work, "
                "and expected outputs described in this work order."
            ),
        },
        "full_text_summary": {
            "type": "string",
            "description": (
                "Comprehensive plain-text summary (under 500 words) of the entire work order: "
                "context, parties, obligations, timelines, and key terms."
            ),
        },
    },
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    filename="ingestion.log",
    level=logging.INFO,
    format="%(asctime)s — %(levelname)s — %(message)s",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pipeline helpers
# ---------------------------------------------------------------------------

def extract_pdf(client: Pulse, pdf_path: str) -> Optional[str]:
    """
    Upload PDF to RunPulse synchronously.
    Returns extraction_id on success, None on failure.
    """
    doc_name = os.path.basename(pdf_path)
    try:
        with open(pdf_path, "rb") as f:
            resp = client.extract(file=f)
        extraction_id = resp.extraction_id
        print(f"  ✅ Extracted → {extraction_id}")
        log.info(f"Extracted '{doc_name}' → {extraction_id}")
        return extraction_id
    except Exception as e:
        print(f"  ❌ Extract failed: {e}")
        log.error(f"Extract failed for '{doc_name}':\n{traceback.format_exc()}")
        return None


def apply_schema(client: Pulse, extraction_id: str, doc_name: str) -> Optional[dict]:
    """
    Apply QCI Work Order schema to an extracted document.
    Returns structured values dict or None on failure.
    """
    try:
        schema_resp = client.schema(
            extraction_id=extraction_id,
            schema_config={"input_schema": WORK_ORDER_SCHEMA},
        )
        # Verified path: SingleSchemaResponse.schema_output.values
        data = schema_resp.schema_output.values

        if not isinstance(data, dict):
            print(f"  ⚠️  Unexpected schema_output type: {type(data)}")
            log.warning(f"Unexpected schema_output for {extraction_id}: {type(data)}")
            return None

        ministry = data.get("ministry", "N/A")
        value    = data.get("value_inr", 0)
        print(f"  📋 Ministry : {ministry}")
        print(f"     Value    : ₹{value:,.0f}" if isinstance(value, (int, float)) else f"     Value    : {value}")
        print(f"     Date     : {data.get('date', 'N/A')}")
        log.info(f"Schema OK for {extraction_id}: ministry='{ministry}', value={value}")
        return data

    except Exception as e:
        print(f"  ❌ Schema failed: {e}")
        log.error(f"Schema failed for extraction {extraction_id}:\n{traceback.format_exc()}")
        return None


def build_document(doc_id: str, data: dict) -> WorkOrderDocument:
    """Assemble WorkOrderDocument from RunPulse schema output."""
    try:
        value_inr = float(data.get("value_inr") or 0.0)
    except (TypeError, ValueError):
        value_inr = 0.0

    meta = WorkOrderMeta(
        doc_id=doc_id,
        ministry=data.get("ministry", "Unknown Ministry"),
        date=data.get("date"),
        value_inr=value_inr,
        domains=data.get("domains") or ["General"],
        project_subject=data.get("project_subject", ""),
        deliverables=data.get("deliverables", ""),
    )
    content = WorkOrderContent(
        full_text=data.get("full_text_summary", ""),
        tables=[],
    )
    return WorkOrderDocument(
        doc_id=doc_id,
        meta=meta,
        content=content,
        graph_nodes=[],
    )


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process_pipeline():
    os.makedirs(PROCESSED_DIR, exist_ok=True)

    pdf_files = sorted(glob.glob(os.path.join(SOURCE_DIR, "*.pdf")))
    if not pdf_files:
        print(f"⚠️  No PDFs found in '{SOURCE_DIR}/'. Run this from the project root.")
        return

    print(f"\n{'═' * 62}")
    print(f"  QCI Central Finite Curve — RunPulse Ingestion")
    print(f"  Source  : {SOURCE_DIR}/  ({len(pdf_files)} PDFs)")
    print(f"  Output  : {PROCESSED_DIR}/")
    print(f"  Provider: RunPulse — SOC 2, zero data retention")
    print(f"{'═' * 62}\n")

    processed_ids = {Path(f).stem for f in glob.glob(os.path.join(PROCESSED_DIR, "*.json"))}
    if processed_ids:
        print(f"  Skipping {len(processed_ids)} already-processed document(s).\n")

    client  = Pulse(api_key=RUNPULSE_API_KEY)
    success = skip = fail = 0

    for i, pdf_path in enumerate(pdf_files, 1):
        doc_id = Path(pdf_path).stem
        print(f"\n{'─' * 62}")
        print(f"  [{i}/{len(pdf_files)}] {doc_id}")

        if doc_id in processed_ids:
            print(f"  ⏭️  Already processed.")
            skip += 1
            continue

        try:
            # Step 1: Extract (OCR + layout)
            print(f"  📤 Uploading to RunPulse...")
            extraction_id = extract_pdf(client, pdf_path)
            if not extraction_id:
                fail += 1
                continue

            # Step 2: Structured schema
            data = apply_schema(client, extraction_id, doc_id)
            if not data:
                fail += 1
                continue

            # Step 3: Build Pydantic model + save JSON
            doc = build_document(doc_id, data)
            save_json(doc, PROCESSED_DIR)
            success += 1
            log.info(f"SUCCESS: {doc_id}")

        except Exception as e:
            fail += 1
            print(f"  ❌ Unexpected error: {e}")
            log.error(f"Pipeline error for '{doc_id}':\n{traceback.format_exc()}")

        time.sleep(RATE_LIMIT_SLEEP)

    print(f"\n{'═' * 62}")
    print(f"  DONE")
    print(f"  ✅ Processed : {success}")
    print(f"  ⏭️  Skipped   : {skip}")
    print(f"  ❌ Failed    : {fail}")
    print(f"  Output: {PROCESSED_DIR}/")
    if fail:
        print(f"  ⚠️  Check ingestion.log for details.")
    print(f"{'═' * 62}\n")


if __name__ == "__main__":
    process_pipeline()
