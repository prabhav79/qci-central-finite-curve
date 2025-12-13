import os
import json
import fitz  # PyMuPDF
from typing import List
from models import WorkOrderDocument

def pdf_to_images(pdf_path: str) -> List[str]:
    """
    Convert PDF pages to temporary image files.
    Returns a list of image file paths.
    """
    doc = fitz.open(pdf_path)
    image_paths = []
    output_dir = "data/temp_images"
    os.makedirs(output_dir, exist_ok=True)
    
    for i in range(len(doc)):
        page = doc.load_page(i)
        pix = page.get_pixmap()
        image_path = os.path.join(output_dir, f"{os.path.basename(pdf_path)}_{i}.png")
        pix.save(image_path)
        image_paths.append(image_path)
    
    return image_paths

def save_json(data: WorkOrderDocument, output_dir: str):
    """
    Save the WorkOrderDocument to a JSON file.
    """
    output_path = os.path.join(output_dir, f"{data.doc_id}.json")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(data.json(indent=2))
    print(f"Saved: {output_path}")

def load_text_from_pdf(pdf_path: str) -> str:
    """
    Fast text extraction using PyMuPDF.
    """
    doc = fitz.open(pdf_path)
    text = ""
    for page in doc:
        text += page.get_text()
    return text
