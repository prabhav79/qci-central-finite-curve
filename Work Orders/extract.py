import pdfplumber
import os
import re
import pandas as pd

# CONFIGURATION
FOLDER_PATH = r"./"
OUTPUT_FILE = "DARPG_Visual_Extract.xlsx"

def clean_text(text):
    if not text: return ""
    return re.sub(r'\s+', ' ', text).strip()

def extract_scope_of_work(full_text):
    # Standard Scope Extraction
    start_markers = [r"Scope\s*of\s*Work", r"Deliverables", r"The\s*work\s*envisages"]
    stop_markers = [r"Financial\s*Plan", r"Financials", r"Payment", r"Composition", r"\d+\.\s*The\s*financials"]
    start_pattern = "(?:" + "|".join(start_markers) + ")"
    stop_pattern = "(?:" + "|".join(stop_markers) + ")"
    match = re.search(rf"(?i)({start_pattern})[:\.\-]*\s*(.*?)(?={stop_pattern})", full_text, re.DOTALL)
    return clean_text(match.group(2)) if match else "Scope Not Found"

def find_cost_visually(page):
    """
    Locates the word 'Total' and scans the row to its right for the largest number.
    """
    # 1. Search for "Total"
    # specific to your docs: usually at the bottom of a table
    results = page.search("Total", regex=False, case=False)
    
    candidates = []

    if results:
        # We might find multiple "Total"s. Check the one lowest on the page (usually the grand total)
        # OR check all of them.
        for rect in results:
            # rect is dictionary-like: {'x0': ..., 'top': ..., 'x1': ..., 'bottom': ...}
            
            # Define a crop box: Start at "Total"'s right edge, go to page width.
            # Add small vertical padding (+5/-5) to catch numbers slightly offset
            x0 = rect['x1']  # Right edge of "Total"
            top = rect['top'] - 5 
            bottom = rect['bottom'] + 5
            width = page.width

            # Crop the page to just this row
            try:
                row_crop = page.crop((x0, top, width, bottom))
                row_text = row_crop.extract_text()
                
                if row_text:
                    # AGGRESSIVE CLEANING: 
                    # "65, 52, 000" -> "6552000"
                    # Remove all spaces and non-digit characters except maybe commas (for safety check)
                    # Actually, let's just strip everything non-digit and check if it looks like a valid price.
                    
                    # Remove spaces specifically to fix the "52,000" error
                    spaceless = row_text.replace(" ", "").replace("\n", "")
                    
                    # Find numbers in this clean string
                    matches = re.findall(r'(\d{4,})', spaceless.replace(",", ""))
                    for m in matches:
                        candidates.append(int(m))
            except Exception as e:
                continue

    # 2. Fallback: Search for "Total Cost" header and look DOWN
    if not candidates:
        header_results = page.search("Total Cost", regex=False, case=False)
        for rect in header_results:
            # Define crop box: Under the header, narrow width
            x0 = rect['x0'] - 20
            x1 = rect['x1'] + 20
            top = rect['bottom']
            bottom = page.height # Look all the way down
            
            try:
                col_crop = page.crop((x0, top, x1, bottom))
                col_text = col_crop.extract_text()
                if col_text:
                    spaceless = col_text.replace(" ", "").replace("\n", "")
                    matches = re.findall(r'(\d{4,})', spaceless.replace(",", ""))
                    for m in matches:
                        candidates.append(int(m))
            except:
                pass

    if candidates:
        return max(candidates) # Return largest number found in the "Total" zones
    return None

def extract_data_from_pdf(pdf_path):
    full_text = ""
    tables_content = []
    max_cost = 0
    
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            full_text += (page.extract_text() or "") + "\n"
            
            # 1. Try Visual Extraction for Cost (The new "Sniper" method)
            visual_cost = find_cost_visually(page)
            if visual_cost and visual_cost > max_cost:
                max_cost = visual_cost
            
            tables = page.extract_tables()
            if tables: tables_content.extend(tables)

    # --- FORMAT COST ---
    if max_cost > 0:
        cost_str = f"{max_cost:,}" # 6,552,000
    else:
        # Fallback to pure text brute force if visual failed completely
        # (This uses the aggressive space remover again)
        spaceless_text = full_text.replace(" ", "").replace("\n", "")
        # Look for numbers > 10,000
        matches = re.findall(r'Rs\.?(\d{4,})', spaceless_text, re.IGNORECASE)
        if not matches:
             matches = re.findall(r'(\d{5,})', spaceless_text) # Any big number
        
        valid_nums = [int(m) for m in matches if int(m) > 10000]
        cost_str = f"{max(valid_nums):,}" if valid_nums else "Cost Not Found"

    # --- OTHER FIELDS ---
    subject_match = re.search(r"Subject:\s*(.*?)(?=\n\s*(?:Sir|Madam),)", full_text, re.DOTALL | re.IGNORECASE)
    subject = clean_text(subject_match.group(1)) if subject_match else "Subject Not Found"

    date_pattern = r"(\d{1,2}[\-\.]\d{1,2}[\-\.]\d{4})"
    duration_match = re.search(r"(?:from|w\.e\.f\.)\s*" + date_pattern + r"\s*to\s*" + date_pattern, full_text, re.IGNORECASE)
    start_date = duration_match.group(1) if duration_match else "Not Found"
    end_date = duration_match.group(2) if duration_match else "Not Found"

    letter_date_match = re.search(r"Dated\s*[:\-]?\s*([\w\d\s,]+20\d{2})", full_text, re.IGNORECASE)
    letter_date = clean_text(letter_date_match.group(1)) if letter_date_match else "Not Found"

    scope_text = extract_scope_of_work(full_text)

    # Payment Milestones
    milestones_str = ""
    for table in tables_content:
        for row in table:
            row_clean = [str(c) if c else "" for c in row]
            row_str = " | ".join(row_clean)
            if "%" in row_str or "Completion" in row_str or "Award" in row_str:
                milestones_str += f"[{row_str}] \n"

    return {
        "File Name": os.path.basename(pdf_path),
        "Letter Date": letter_date,
        "Subject": subject,
        "Start Date": start_date,
        "End Date": end_date,
        "Total Cost": cost_str,
        "Scope / Deliverables": scope_text[:32000],
        "Payment Milestones": milestones_str[:32000]
    }

def main():
    all_data = []
    print(f"Scanning folder: {FOLDER_PATH}...")
    
    files = [f for f in os.listdir(FOLDER_PATH) if f.lower().endswith('.pdf')]
    
    for filename in files:
        full_path = os.path.join(FOLDER_PATH, filename)
        print(f"Processing: {filename}")
        try:
            data = extract_data_from_pdf(full_path)
            all_data.append(data)
        except Exception as e:
            print(f"Error processing {filename}: {e}")

    if all_data:
        df = pd.DataFrame(all_data)
        cols = ["File Name", "Letter Date", "Subject", "Start Date", "End Date", "Total Cost", "Scope / Deliverables", "Payment Milestones"]
        df = df[cols]
        df.to_excel(OUTPUT_FILE, index=False)
        print(f"\n✅ Success! Report saved to: {OUTPUT_FILE}")

if __name__ == "__main__":
    main()