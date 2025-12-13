import os
import glob
import json
import re
import pdfplumber
import fitz # PyMuPDF
import cv2
import numpy as np
# from pdf2image import convert_from_path # Removed to avoid Poppler dependency
import easyocr
from typing import List, Dict, Any, Optional
from models import WorkOrderDocument, WorkOrderMeta, TableData, GraphNode, WorkOrderContent

# Initialize EasyOCR reader once
reader = easyocr.Reader(['en'])

class QCILibrarian:
    def __init__(self, raw_dir="data/raw", processed_dir="data/processed"):
        self.raw_dir = raw_dir
        self.processed_dir = processed_dir
        os.makedirs(processed_dir, exist_ok=True)

    def is_digital(self, pdf_path: str) -> bool:
        """Check if PDF has selectable text."""
        with pdfplumber.open(pdf_path) as pdf:
            if len(pdf.pages) == 0: return False
            # Check first page text density
            text = pdf.pages[0].extract_text()
            return len(text.strip()) > 50 if text else False

    def extract_digital(self, pdf_path: str) -> Dict[str, Any]:
        """Extract content from digital PDF using pdfplumber."""
        print(f"Extraction (Digital): {os.path.basename(pdf_path)}")
        full_text = ""
        tables_data = []
        
        with pdfplumber.open(pdf_path) as pdf:
            for i, page in enumerate(pdf.pages):
                # Extract text
                page_text = page.extract_text()
                if page_text:
                    full_text += page_text + "\n"
                
                # Extract tables
                tables = page.extract_tables()
                for table in tables:
                    # Clean None values
                    cleaned_table = [[cell if cell else "" for cell in row] for row in table]
                    tables_data.append({
                        "table_id": i + 1,
                        "data": json.dumps(cleaned_table), 
                        "description": f"Table on page {i+1}"
                    })
                    
        return {
            "full_text": full_text,
            "tables": tables_data
        }

    def extract_scanned(self, pdf_path: str) -> Dict[str, Any]:
        """Extract content from scanned PDF using EasyOCR (via PyMuPDF images)."""
        print(f"Extraction (Scan): {os.path.basename(pdf_path)}")
        full_text = ""
        tables_data = [] 
        
        try:
            # Use PyMuPDF (fitz) instead of pdf2image to avoid Poppler dependency
            doc = fitz.open(pdf_path)
            for i, page in enumerate(doc):
                # Render page to image (pixmap)
                pix = page.get_pixmap(dpi=300) # High DPI for better OCR
                img_data = pix.tobytes("png")
                
                # Convert bytes to numpy array for EasyOCR (via CV2)
                nparr = np.frombuffer(img_data, np.uint8)
                img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                
                # EasyOCR
                result = reader.readtext(img, detail=0)
                page_text = " ".join(result)
                full_text += page_text + "\n"
                
        except Exception as e:
            print(f"OCR Failed: {e}")
            return {"full_text": "OCR Failed", "tables": []}
            
        return {
            "full_text": full_text,
            "tables": []
        }

    def parse_metadata(self, text: str, filename: str) -> WorkOrderMeta:
        """Regex/Heuristics to extract Metadata from Work Offers."""
        # Clean text specifically for regex (remove excessive newlines for multiline matching)
        clean_text = text.replace("\n", " ")
        
        # 1. Ministry extraction
        ministry = "Unknown"
        # Look for "Government of India" followed by "Ministry of ..."
        ministry_match = re.search(r"Government of India\s+(Ministry of [A-Za-z\s,]+)", clean_text, re.IGNORECASE)
        if ministry_match:
            ministry = ministry_match.group(1).strip().rstrip(",")
        else:
            # Fallback: Just look for "Ministry of X" at start of lines
            simple_ministry = re.search(r"(Ministry of [A-Za-z\s]+)", text)
            if simple_ministry:
                ministry = simple_ministry.group(1).strip()

        # 2. Date extraction
        # Pattern: dated the 14th July, 2022 or 14.07.2022
        date = None
        # Try explicit "dated" pattern first
        date_match = re.search(r"dated\s+(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s*,?\s*\d{4})", clean_text, re.IGNORECASE)
        if date_match:
            date = date_match.group(1)
        else:
            # Standard DD/MM/YYYY
            date_match_simple = re.search(r"\b(\d{2}[-/]\d{2}[-/]\d{4})\b", text)
            if date_match_simple:
                date = date_match_simple.group(1)
            else:
                # Textual Month: February 07, 2023
                date_match_text = re.search(r"[A-Za-z]+\s+\d{1,2},?\s+\d{4}", text)
                if date_match_text:
                    date = date_match_text.group(0)

        # 3. Value extraction (INR)
        # Pattern: Rs. 65,52,000/- or Rs.6552000
        value = 0.0
        # Look for Rs. followed by digits/commas
        val_match = re.search(r"Rs\.?\s*([\d,]+)/?", text)
        if val_match:
            val_str = val_match.group(1).replace(",", "")
            try:
                value = float(val_str)
            except:
                pass

        # 4. Subject extraction (New field in Meta logic, even if not in Schema yet, useful to have)
        # We can put it in doc_id or tags if schema is strict, or just log it.
        # Let's try to infer domains from Subject.
        subject = ""
        subj_match = re.search(r"Subject\s*:\s*(.*?)(?:\.|(?=\n[A-Z]))", text.replace("\n", " "), re.IGNORECASE)
        if subj_match:
            subject = subj_match.group(1).strip()
            
        return WorkOrderMeta(
            doc_id=filename.replace(".pdf", ""),
            ministry=ministry,
            date=date,
            value_inr=value,
            domains=[subject[:50]] if subject else ["General"] # Use Subject start as domain proxy for now
        )

    def process(self):
        files = glob.glob(os.path.join(self.raw_dir, "*.pdf"))
        print(f"Found {len(files)} files.")
        
        for f in files:
            fname = os.path.basename(f)
            try:
                if self.is_digital(f):
                    content = self.extract_digital(f)
                else:
                    content = self.extract_scanned(f)
                
                # Structure
                meta = self.parse_metadata(content["full_text"], fname)
                
                # Create Document
                doc = WorkOrderDocument(
                    doc_id=fname.replace(".pdf", ""),
                    meta=meta,
                    content=WorkOrderContent(
                        full_text=content["full_text"],
                        tables=[TableData(**t) for t in content["tables"]]
                    ),
                    graph_nodes=[] # Placeholder
                )
                
                # Save
                try:
                    # Robust save for Pydantic v1/v2 compatibility
                    if hasattr(doc, "model_dump"):
                        data_dict = doc.model_dump()
                    else:
                        data_dict = doc.dict()
                        
                    with open(os.path.join(self.processed_dir, f"{doc.doc_id}.json"), "w", encoding='utf-8') as out:
                        json.dump(data_dict, out, indent=2, default=str)
                    
                    print(f"Saved {doc.doc_id}.json")
                except Exception as e:
                    print(f"Save Failed {fname}: {e}")
                
            except Exception as e:
                print(f"Failed {fname}: {e}")

if __name__ == "__main__":
    lib = QCILibrarian()
    lib.process()
