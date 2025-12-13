import os
import json
import re
import glob
from datetime import datetime

# Define Pydantic-like structure manually to avoid path issues
# Target Schema:
# {
#     "doc_id": str,
#     "meta": {
#         "ministry": str,
#         "date": str (YYYY-MM-DD) or null,
#         "value_inr": float or null,
#         "domains": [str],
#         "doc_id": str
#     },
#     "content": {
#         "full_text": str,
#         "tables": []
#     },
#     "graph_nodes": []
# }

INPUT_DIR = os.path.join("data", "extracted_text")
OUTPUT_DIR = os.path.join("data", "processed")

def parse_date(text):
    # Regex patterns for date
    date_patterns = [
        r'[A-Za-z]{3,9}\s\d{1,2},?\s\d{4}', # June 11, 2025 or June 11 2025
        r'\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4}', # 14th July, 2022
        r'dated\s+the\s+(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4})', # dated the 14th July, 2022
        r'\d{2}/\d{2}/\d{4}',       # 27/11/2025
        r'\d{2}-\d{2}-\d{4}',       # 27-11-2025
        r'\d{1,2}\.\d{1,2}\.\d{4}', # 27.11.2025 or 5.7.2022
        r'\d{2}\s[A-Za-z]{3}\s\d{4}' # 11 Jun 2025
    ]

    for pattern in date_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for date_str in matches:
            # If match is a tuple (from group), take the full string
            if isinstance(date_str, tuple):
                date_str = date_str[0]
                
            # Clean up suffixes like 'th', 'nd'
            clean_date = re.sub(r'(st|nd|rd|th)', '', date_str).replace(',', '').strip()
            
            # Try various formats
            formats = [
                '%B %d %Y', '%d %B %Y', 
                '%d/%m/%Y', '%d-%m-%Y', '%d.%m.%Y', 
                '%d %b %Y'
            ]
            
            for fmt in formats:
                try:
                    return datetime.strptime(clean_date, fmt).date().isoformat()
                except ValueError:
                    continue
    return None

def parse_amount(text):
    # Adapted from ocr.py
    text_lower = text.lower()
    
    # 1. Look for specific totals
    golden_patterns = [
        r'total cost\s*[:=-]?\s*\D*?([\d,]+\.?\d*)',
        r'grand total\s*[:=-]?\s*\D*?([\d,]+\.?\d*)',
        r'net payable\s*[:=-]?\s*\D*?([\d,]+\.?\d*)',
        r'cost of Rs\.?\s*([\d,]+\.?\d*)', # "cost of Rs.65,52,000/-"
        r'Rs\.?\s*([\d,]+\.?\d*)\s*\(.*only\)', # Rs. 65,52,000/- (... only) - very strong signal
    ]

    for pattern in golden_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        if matches:
            try:
                # Take the last match that parses successfully
                for match in reversed(matches):
                    # Remove commas and handle accidental trailing dots
                    clean_val = match.replace(',', '').rstrip('.')
                    return float(clean_val)
            except ValueError:
                continue

    return None

def extract_ministry(text):
    # Simple heuristic
    lines = text.split('\n')
    for line in lines[:10]: # Check first 10 lines
        if "Ministry of" in line:
            return line.strip().strip(',').strip()
    return "Department of Administrative Reforms and Public Grievances" # Default for this dataset

def extract_domains(text):
    # Keyword matching
    domains = []
    keywords = {
        "CPGRAMS": "Grievance Redressal",
        "NeSDA": "E-Governance",
        "SCDPM": "Capacity Building", # Guessing
        "PMU": "Project Management"
    }
    for key, val in keywords.items():
        if key in text:
            domains.append(val)
    return list(set(domains))

def extract_project_subject(text):
    # Look for "Subject" or "Sub" at start of line
    # Example: "Subject Setting up of PMU..."
    match = re.search(r'(?:Subject|Sub\.?)\s*[:\-\s]\s*(.*)', text, re.IGNORECASE)
    if match:
        # Get the first line of the subject
        subject_line = match.group(1).strip()
        # Sometimes subject spans multiple lines until "Sir" or "Madam" or date
        # For now, let's take the single line or up to a reasonable length
        return subject_line[:300]
    return "Unknown Subject"

def extract_deliverables(text):
    # Look for "Deliverables" block
    # Start: Deliverables, Scope of Work
    # End: Payment, Milestones, Terms, Copy to
    
    start_pattern = r'(?:Deliverables|Scope of Work|Detailed Plan of Actions)'
    end_pattern = r'(?:Payment|Milestones|Terms|Copy to|Yours faithfully)'
    
    match = re.search(f'({start_pattern}.*?)({end_pattern})', text, re.IGNORECASE | re.DOTALL)
    
    if match:
        # Return the captured content between start and end
        # Clean up newlines/spaces
        content = match.group(1).strip()
        # Limit length just in case
        return content[:5000]
        
    return ""

def structure_data():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        print(f"Created output directory: {OUTPUT_DIR}")

    txt_files = glob.glob(os.path.join(INPUT_DIR, "*.txt"))
    
    if not txt_files:
        print(f"No text files found in {INPUT_DIR}")
        return

    print(f"Found {len(txt_files)} extracted text files to process.")

    for txt_file in txt_files:
        print(f"Structuring: {txt_file}")
        
        with open(txt_file, "r", encoding="utf-8") as f:
            full_text = f.read()

        filename = os.path.basename(txt_file)
        doc_id = os.path.splitext(filename)[0]

        # Populate Fields
        meta = {
            "ministry": extract_ministry(full_text),
            "date": parse_date(full_text),
            "value_inr": parse_amount(full_text),
            # Keep domains as tags, but add specific subject
            "domains": extract_domains(full_text),
            "project_subject": extract_project_subject(full_text),
            "doc_id": doc_id
        }

        # Construct Final JSON
        document = {
            "doc_id": doc_id,
            "meta": meta,
            "content": {
                "full_text": full_text,
                "deliverables": extract_deliverables(full_text),
                "tables": [] # Placeholder
            },
            "graph_nodes": [] # Placeholder
        }

        output_path = os.path.join(OUTPUT_DIR, f"{doc_id}.json")
        
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(document, f, indent=2)
            
        print(f"✅ Saved JSON to: {output_path}")

if __name__ == "__main__":
    structure_data()
