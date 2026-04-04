"""
QCI Central Finite Curve — RunPulse Ingestion Pipeline
=======================================================
Replaces: Google Vertex AI (Gemini), Google Cloud Vision, EasyOCR
Provider:  RunPulse (https://runpulse.com) — SOC 2 compliant, zero data retention

Pipeline:
  1. Upload each Work Order PDF to RunPulse (/extract) — handles OCR, tables, layout
  2. Apply our QCI Work Order JSON schema (/schema) — returns structured metadata
  3. Save output to data/processed/<doc_id>.json (same format app.py reads)

Usage:
  python src/runpulse_ingestion.py

Requirements:
  RUNPULSE_API_KEY in .env (locally) or Streamlit Cloud Secrets (production)
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
from pulse.types import ExtractRequestFigureProcessing
from dotenv import load_dotenv

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
        "RUNPULSE_API_KEY not set. Add it to your .env file locally, "
        "or to Streamlit Cloud Secrets for deployment."
    )

# Source PDFs live in Work Orders/ (relative to project root)
# Run this script from the project root: python src/runpulse_ingestion.py
SOURCE_DIR = "Work Orders"
PROCESSED_DIR = "data/processed"

# How long to sleep between documents to be polite to the API (seconds)
RATE_LIMIT_SLEEP = 2

# Async polling config
POLL_INTERVAL = 3   # seconds between status checks
POLL_TIMEOUT = 300  # max seconds to wait per document

# ---------------------------------------------------------------------------
# RunPulse schema for QCI Work Orders
# ---------------------------------------------------------------------------
# This tells RunPulse exactly what structured fields to extract.
# The schema matches our WorkOrderMeta + WorkOrderContent Pydantic models.
WORK_ORDER_SCHEMA = {
    "type": "object",
    "properties": {
        "ministry": {
            "type": "string",
            "description": (
                "Full name of the Indian Government Ministry or Department "
                "that issued this work order (e.g. 'Ministry of Personnel, Public Grievances and Pensions', "
                "'Department of Administrative Reforms and Public Grievances')"
            ),
        },
        "date": {
            "type": "string",
            "description": "Date the work order was issued, formatted as YYYY-MM-DD.",
        },
        "value_inr": {
            "type": "number",
            "description": (
                "Total monetary value of the work order in Indian Rupees (INR). "
                "Extract as a plain number without commas or currency symbols."
            ),
        },
        "domains": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "2–5 topic tags describing the subject area of this work order, "
                "e.g. ['Grievance Redressal', 'Digital Governance', 'PMU Support']"
            ),
        },
        "project_subject": {
            "type": "string",
            "description": (
                "The specific subject or title of the project/assignment as stated "
                "in the work order (e.g. 'CPGRAMS PMU Support for DARPG')."
            ),
        },
        "deliverables": {
            "type": "string",
            "description": (
                "A concise plain-text summary (max 400 words) of the key deliverables, "
                "scope of work, and expected outputs described in the work order."
            ),
        },
        "full_text_summary": {
            "type": "string",
            "description": (
                "A comprehensive plain-text summary (max 500 words) of the entire "
                "work order capturing context, parties involved, obligations, and timeline."
            ),
        },
    },
    "required": ["ministry", "date", "value_inr", "domains", "project_subject", "deliverables", "full_text_summary"],
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
# Core extraction functions
# ---------------------------------------------------------------------------

def extract_with_runpulse(client: Pulse, pdf_path: str) -> Optional[str]:
    """
    Upload a PDF to RunPulse and return the extraction_id.
    Uses async mode for large/scanned documents with polling.
    Returns extraction_id on success, None on failure.
    """
    doc_name = os.path.basename(pdf_path)
    print(f"  📤 Uploading to RunPulse: {doc_name}")

    try:
        with open(pdf_path, "rb") as f:
            submission = client.extract(
                file=f,
                figure_processing=ExtractRequestFigureProcessing(description=True),
                async_=True,  # Always async — some QCI PDFs are large scans
            )

        job_id = submission.job_id
        print(f"  ⏳ Job submitted: {job_id} — polling for completion...")
        log.info(f"JobID {job_id} submitted for {doc_name}")

        # Poll until done
        elapsed = 0
        while elapsed < POLL_TIMEOUT:
            time.sleep(POLL_INTERVAL)
            elapsed += POLL_INTERVAL

            status = client.jobs.get_job(job_id=job_id)
            print(f"  ↻  [{elapsed}s] Status: {status.status}")

            if status.status == "completed":
                extraction_id = status.result.extraction_id
                print(f"  ✅ Extraction complete: {extraction_id}")
                log.info(f"JobID {job_id} → extraction_id {extraction_id}")
                return extraction_id

            elif status.status in ("failed", "canceled"):
                print(f"  ❌ Job ended with status: {status.status}")
                log.error(f"JobID {job_id} ended: {status.status}")
                return None

        print(f"  ⚠️  Timeout after {POLL_TIMEOUT}s for {doc_name}")
        log.warning(f"Timeout for {doc_name} (job {job_id})")
        return None

    except Exception as e:
        print(f"  ❌ Extract failed: {e}")
        log.error(f"Extract failed for {doc_name}: {traceback.format_exc()}")
        return None


def apply_schema(client: Pulse, extraction_id: str, doc_name: str) -> Optional[dict]:
    """
    Apply the QCI Work Order schema to an already-extracted document.
    Returns a dict of structured fields, or None on failure.
    """
    print(f"  📋 Applying Work Order schema...")
    try:
        result = client.schema(
            extraction_id=extraction_id,
            schema_config={"input_schema": WORK_ORDER_SCHEMA},
        )
        # result.output is the structured dict
        data = result.output if hasattr(result, "output") else result
        if isinstance(data, str):
            data = json.loads(data)
        print(f"  ✅ Schema applied — ministry: {data.get('ministry', 'N/A')}, value: ₹{data.get('value_inr', 0):,.0f}")
        return data
    except Exception as e:
        print(f"  ❌ Schema extraction failed: {e}")
        log.error(f"Schema failed for extraction {extraction_id}: {traceback.format_exc()}")
        return None


def build_document(doc_id: str, schema_data: dict) -> WorkOrderDocument:
    """
    Assemble a WorkOrderDocument from RunPulse schema output.
    Matches the exact structure app.py reads from data/processed/*.json.
    """
    meta = WorkOrderMeta(
        doc_id=doc_id,
        ministry=schema_data.get("ministry", "Unknown Ministry"),
        date=schema_data.get("date"),
        value_inr=float(schema_data.get("value_inr") or 0.0),
        domains=schema_data.get("domains", ["General"]),
        # Extra enriched fields stored in meta for use by app.py
        project_subject=schema_data.get("project_subject", ""),
        deliverables=schema_data.get("deliverables", ""),
    )

    content = WorkOrderContent(
        full_text=schema_data.get("full_text_summary", ""),
        tables=[],  # RunPulse table extraction available via /tables endpoint if needed later
    )

    return WorkOrderDocument(
        doc_id=doc_id,
        meta=meta,
        content=content,
        graph_nodes=[],  # Auto-computed by app.py from ministry/doc_id
    )


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process_pipeline():
    os.makedirs(PROCESSED_DIR, exist_ok=True)

    # Find all PDFs in Work Orders/
    pdf_files = sorted(glob.glob(os.path.join(SOURCE_DIR, "*.pdf")))
    if not pdf_files:
        print(f"⚠️  No PDFs found in '{SOURCE_DIR}'. Make sure you run this from the project root.")
        return

    print(f"\n🚀 RunPulse Ingestion Pipeline")
    print(f"   Source : {SOURCE_DIR}/ ({len(pdf_files)} PDFs)")
    print(f"   Output : {PROCESSED_DIR}/")
    print(f"   Provider: RunPulse (SOC 2, zero data retention)\n")

    # Skip already-processed documents
    processed_ids = {
        Path(f).stem for f in glob.glob(os.path.join(PROCESSED_DIR, "*.json"))
    }

    client = Pulse(api_key=RUNPULSE_API_KEY)

    success_count = 0
    skip_count = 0
    fail_count = 0

    for pdf_path in pdf_files:
        doc_id = Path(pdf_path).stem
        print(f"\n{'─' * 60}")
        print(f"📄 {doc_id}")

        if doc_id in processed_ids:
            print(f"  ⏭️  Already processed — skipping.")
            skip_count += 1
            continue

        try:
            # Step 1: Extract (OCR + layout)
            extraction_id = extract_with_runpulse(client, pdf_path)
            if not extraction_id:
                fail_count += 1
                continue

            # Step 2: Apply our structured schema
            schema_data = apply_schema(client, extraction_id, doc_id)
            if not schema_data:
                fail_count += 1
                continue

            # Step 3: Build model and save JSON
            doc = build_document(doc_id, schema_data)
            save_json(doc, PROCESSED_DIR)

            success_count += 1
            log.info(f"SUCCESS: {doc_id}")

        except Exception as e:
            fail_count += 1
            err = traceback.format_exc()
            print(f"  ❌ Pipeline error: {e}")
            log.error(f"FAILED {doc_id}:\n{err}")

        # Rate limiting between documents
        time.sleep(RATE_LIMIT_SLEEP)

    print(f"\n{'═' * 60}")
    print(f"✅ Done. Processed: {success_count}  Skipped: {skip_count}  Failed: {fail_count}")
    print(f"   Output in: {PROCESSED_DIR}/")
    if fail_count:
        print(f"   ⚠️  Check ingestion.log for error details.")


if __name__ == "__main__":
    process_pipeline()
