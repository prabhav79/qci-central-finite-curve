import os
import glob
import time
import shutil
import json
import traceback

from google.oauth2 import service_account
import vertexai
from vertexai.generative_models import GenerativeModel, Part, FinishReason
import vertexai.preview.generative_models as generative_models

from models import WorkOrderDocument, WorkOrderMeta, TableData, GraphNode, WorkOrderContent
from utils import pdf_to_images, load_text_from_pdf, save_json
from dotenv import load_dotenv

load_dotenv()

# Vertex AI Configuration
SERVICE_ACCOUNT_FILE = "service_account.json"
PROJECT_ID = "qci-pmu-ocr"
LOCATION = "us-central1" # Default to us-central1 for Vertex

credentials = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE)
vertexai.init(project=PROJECT_ID, location=LOCATION, credentials=credentials)

# Using Gemini 1.0 Pro (Text Only) as fallback due to Vision 404s
MODEL_NAME = "gemini-1.0-pro" 

def analyze_document_with_gemini(file_path: str, text_content: str) -> WorkOrderDocument:
    model = GenerativeModel(MODEL_NAME)
    
    is_scan = len(text_content.strip()) < 100 
    
    prompt = """
    You are an AI Librarian for QCI.
    Extract the information from the Work Order document.
    Return ONLY valid JSON complying exactly with this schema. Do not wrap in markdown code blocks.
    
    {
        "doc_id": "filename_without_extension",
        "meta": {
            "ministry": "Ministry Name",
            "date": "YYYY-MM-DD",
            "value_inr": 12345.0,
            "domains": ["Tag1", "Tag2"],
            "doc_id": "filename_without_extension"
        },
        "content": {
            "full_text": "Summary of text max 500 words...",
            "tables": [
                { "table_id": 1, "data": "JSON string", "description": "desc" }
            ]
        },
        "graph_nodes": [
            { "source": "Entity1", "target": "Entity2", "relation": "Type", "weight": 1 }
        ]
    }
    """
    
    parts = [prompt]
    
    if is_scan:
        print(f"Detected scan: {file_path}. Vision NOT AVAILABLE (404). Trying text fallback.")
        # Fallback to whatever text exists or empty
        parts.append(f"Document Text (Scanned/Low Quality):\n{text_content[:30000]}")
    else:
        print(f"Detected text: {file_path}. Using Text mode.")
        parts.append(f"Document Text:\n{text_content[:30000]}") # 30k chars context

    # Generation config
    generation_config = {
        "max_output_tokens": 8192,
        "temperature": 0.1,
        "response_mime_type": "application/json",
    }
    
    # Safety settings to block less
    safety_settings = {
        generative_models.HarmCategory.HARM_CATEGORY_HATE_SPEECH: generative_models.HarmBlockThreshold.BLOCK_ONLY_HIGH,
        generative_models.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: generative_models.HarmBlockThreshold.BLOCK_ONLY_HIGH,
        generative_models.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: generative_models.HarmBlockThreshold.BLOCK_ONLY_HIGH,
        generative_models.HarmCategory.HARM_CATEGORY_HARASSMENT: generative_models.HarmBlockThreshold.BLOCK_ONLY_HIGH,
    }

    try:
        response = model.generate_content(
            parts,
            generation_config=generation_config,
            safety_settings=safety_settings,
        )
        
        json_str = response.text
        # Clean potential markdown
        if json_str.strip().startswith("```json"):
            json_str = json_str.strip()[7:-3]
        elif json_str.strip().startswith("```"):
            json_str = json_str.strip()[3:-3]
            
        data = json.loads(json_str)
        
        # Enforce ID
        data['doc_id'] = os.path.basename(file_path).replace(".pdf", "")
        # Ensure meta knows doc_id too if needed or let Pydantic handle default None
        
        return WorkOrderDocument(**data)
        
    except Exception as e:
        # print(f"Generate Error: {e}")
        raise e

def process_pipeline():
    raw_dir = "data/raw"
    processed_dir = "data/processed"
    quarantine_dir = "data/quarantine"
    
    files = glob.glob(os.path.join(raw_dir, "*.pdf"))
    print(f"Init: Found {len(files)} PDFs in {raw_dir}")
    
    # Check what is already processed to avoid re-work
    processed_ids = [f.replace(".json", "") for f in os.listdir(processed_dir)]
    
    for file_path in files:
        doc_id = os.path.basename(file_path).replace(".pdf", "")
        if doc_id in processed_ids:
            print(f"Skipping {doc_id} (already processed)")
            continue

        try:
            print(f"Processing {doc_id} with Vertex AI...")
            text = load_text_from_pdf(file_path)
            
            doc_model = analyze_document_with_gemini(file_path, text)
            
            save_json(doc_model, processed_dir)
             
            # Vertex AI has higher limits (usually 60 RPM), so 1s sleep is fine
            time.sleep(1)
            
        except Exception as e:
            err = traceback.format_exc()
            print(f"FAILED {doc_id}")
            with open("ingestion.log", "a") as f:
                f.write(f"\n--- ERROR {doc_id} ---\n")
                f.write(err)
                f.write(str(e))
            # Don't move to quarantine yet, just log. 
            # shutil.copy(file_path, quarantine_dir)

if __name__ == "__main__":
    process_pipeline()
