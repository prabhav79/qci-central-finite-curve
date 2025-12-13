import os
import re
from google.cloud import vision
from datetime import datetime
from pdf2image import convert_from_path

# 1. SETUP CREDENTIALS
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "credentials.json"

# 2. SETUP POPPLER PATH (KEEP YOUR EXISTING PATH HERE)
# Example: POPPLER_PATH = r"C:\poppler\Library\bin"
POPPLER_PATH = r"C:\poppler\Library\bin" 

def extract_bill_data(file_path):
    """
    Main entry point. Handles multi-page PDFs and Images.
    """
    image_paths = []

    # A. Check extension and Convert
    if file_path.lower().endswith('.pdf'):
        print(f"📄 Detected PDF: {file_path}. Converting ALL pages...")
        image_paths = convert_pdf_to_images(file_path)
    else:
        image_paths = [file_path]

    # B. Process ALL pages and combine text
    full_combined_text = ""
    
    if not image_paths:
        return {"vendor": "Error", "date": None, "amount": 0.0, "order_id": ""}

    for img in image_paths:
        text = process_image_with_google(img)
        full_combined_text += text + "\n" 
        
        # Cleanup temp files
        if file_path.lower().endswith('.pdf') and os.path.exists(img):
            os.remove(img)

    # Debugging: Print a snippet to ensure we are reading the bottom of the bill
    print(f"--- Text Snippet (Last 500 chars) ---\n...{full_combined_text[-500:]}\n-------------------------")

    return {
        "vendor": parse_vendor(full_combined_text),
        "date": parse_date(full_combined_text),
        "amount": parse_amount(full_combined_text),
        "order_id": parse_order_id(full_combined_text)
    }

def convert_pdf_to_images(pdf_path):
    try:
        pages = convert_from_path(pdf_path, poppler_path=POPPLER_PATH)
        temp_paths = []
        for i, page in enumerate(pages):
            temp_name = f"temp_page_{i}.jpg"
            page.save(temp_name, 'JPEG')
            temp_paths.append(temp_name)
        return temp_paths
    except Exception as e:
        print(f"❌ PDF Conversion Error: {e}")
        return []

def process_image_with_google(image_path):
    client = vision.ImageAnnotatorClient()
    with open(image_path, "rb") as image_file:
        content = image_file.read()
    image = vision.Image(content=content)
    try:
        response = client.text_detection(image=image)
        if response.text_annotations:
            return response.text_annotations[0].description
    except Exception as e:
        print(f"❌ Google API Error: {e}")
    return ""

def parse_date(text):
    # Regex patterns for date
    date_patterns = [
        r'[A-Za-z]{3,9}\s\d{1,2},\s\d{4}', # June 11, 2025
        r'\d{2}/\d{2}/\d{4}',       # 27/11/2025
        r'\d{2}-\d{2}-\d{4}',       # 27-11-2025
        r'\d{2}\.\d{2}\.\d{4}',     # 27.11.2025
        r'\d{2}\s[A-Za-z]{3}\s\d{4}' # 11 Jun 2025
    ]

    for pattern in date_patterns:
        matches = re.findall(pattern, text)
        for date_str in matches:
            clean_date = date_str.replace(',', '')
            for fmt in ('%B %d %Y', '%d/%m/%Y', '%d-%m-%Y', '%d.%m.%Y', '%d %b %Y'):
                try:
                    return datetime.strptime(clean_date, fmt).date()
                except ValueError:
                    continue
    return None

def parse_amount(text):
    """
    Intelligent parsing that prefers 'Order Total' over 'Item Total'.
    """
    text_lower = text.lower()
    
    # TIER 1: The "Golden" Keywords (Specific Final Totals)
    # We look for the phrase, followed by optional symbols (:, -, Rs), then the number
    golden_patterns = [
        r'order total\s*[:=-]?\s*\D*?([\d,]+\.?\d*)',    # Matches "Order Total: Rs 385"
        r'paid via\s*[:=-]?\s*\D*?([\d,]+\.?\d*)',       # Matches "Paid Via Credit Card: 385"
        r'grand total\s*[:=-]?\s*\D*?([\d,]+\.?\d*)',    # Matches "Grand Total: 385"
        r'net payable\s*[:=-]?\s*\D*?([\d,]+\.?\d*)'
    ]

    for pattern in golden_patterns:
        matches = re.findall(pattern, text_lower)
        if matches:
            # If found, taking the LAST match is usually safest (bottom of page)
            try:
                val = float(matches[-1].replace(',', ''))
                print(f"✅ Found High-Confidence Amount ({pattern}): {val}")
                return val
            except ValueError:
                continue

    # TIER 2: Fallback to "Total" but be careful
    # If we didn't find "Order Total", look for "Total"
    # But we explicitly avoid "Item Total" if possible by checking line by line
    lines = text.split('\n')
    keywords = ['total', 'amount', 'payable']
    candidates = []

    for line in lines:
        line_lower = line.lower()
        if any(k in line_lower for k in keywords):
            # Exclude lines that are clearly subtotals if we can
            if "item total" in line_lower or "sub" in line_lower:
                continue 
            
            # Extract number
            nums = re.findall(r"[-+]?\d*\.\d+|\d+", line.replace(',', ''))
            if nums:
                try:
                    candidates.append(float(nums[-1]))
                except ValueError:
                    continue
    
    if candidates:
        # If we have candidates, usually the one appearing LAST in the document is the final total
        # (Bills list items first, total last)
        print(f"⚠️ Using Fallback Logic. Candidates: {candidates}")
        return candidates[-1]

    return 0.0

def parse_order_id(text):
    """
    Extracts Order ID / Bill Number.
    """
    # Specific patterns for Swiggy/Zomato
    # We look for "Order No", "Order #", etc followed by digits.
    patterns = [
        r'Order\s*No\s*[:.-]?\s*(\d+)',        # Order No: 20488...
        r'Order\s*#\s*[:.-]?\s*(\d+)',         # Order #20488...
        r'Bill\s*No\s*[:.-]?\s*(\w+)',         # Bill No: 12345
        r'Invoice\s*No\s*[:.-]?\s*(\w+)',      # Invoice No: 12345
        r'Id\s*[:.-]?\s*(\d+)'                 # Id: 12345 (Strictly digits to avoid "Email Id")
    ]
    
    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            clean_match = match.strip()
            # Must contain at least one digit to be a valid ID
            if any(char.isdigit() for char in clean_match):
                # Filter out "Summary" or other non-ID words if regex slipped
                if clean_match.lower() not in ['summary', 'total', 'details']:
                    print(f"✅ Found Order ID: {clean_match}")
                    return clean_match
    return ""

def clean_vendor_string(vendor_str):
    """
    Helper to strip leading digits/IDs from vendor name.
    E.g. "20488... Thalairaj Biryani" -> "Thalairaj Biryani"
    """
    if not vendor_str:
        return "Unknown Vendor"
    
    # Remove leading digits and spaces/symbols
    # Matches "12345 ", "12345- ", "#12345 "
    cleaned = re.sub(r'^[\d#\-\.:]+\s*', '', vendor_str).strip()
    
    return cleaned if len(cleaned) > 2 else "Unknown Vendor"

def parse_vendor(text):
    """
    Improved Vendor/Restaurant extraction.
    """
    lines = text.split('\n')
    
    # Strategy 1: Look for "Restaurant" label (Common in Swiggy)
    for i, line in enumerate(lines):
        if "Restaurant" in line:
            # Case A: "Restaurant: Thalairaj Biryani" (Same line)
            parts = line.split("Restaurant")
            if len(parts) > 1 and len(parts[1].strip()) > 3:
                clean_vendor = parts[1].strip(" :.-")
                print(f"✅ Found Vendor (Label Strategy): {clean_vendor}")
                return clean_vendor_string(clean_vendor)
            
            # Case B: "Restaurant" is a header, name is on NEXT line
            # We check the next line if it exists
            if i + 1 < len(lines):
                next_line = lines[i+1].strip()
                if len(next_line) > 3 and "Order" not in next_line:
                     print(f"✅ Found Vendor (Next Line Strategy): {next_line}")
                     return clean_vendor_string(next_line)

    # Strategy 2: Fallback to top lines (Heuristic)
    ignore_list = [
        "tax invoice", "bill of supply", "original", "duplicate", "copy",
        "swiggy", "zomato", "ubereats", "foodpanda", "total", "date", "amount",
        "gst", "fssai", "invoice", "order", "summary", "details", "restaurant",
        "page", "of", "1 of", "2 of" # Ignore page numbers
    ]

    for line in lines[:15]: 
        clean = line.strip()
        clean_lower = clean.lower()
        
        if len(clean) < 3:
            continue
            
        is_ignored = False
        for term in ignore_list:
            if term in clean_lower:
                is_ignored = True
                break
        
        # Extra check: Don't pick up "1 of 3"
        if re.search(r'\d+\s+of\s+\d+', clean_lower):
            is_ignored = True

        if not is_ignored:
            print(f"✅ Found Potential Vendor (Heuristic): {clean}")
            return clean_vendor_string(clean)

    return "Unknown Vendor"

if __name__ == "__main__":
    test_file = "static/uploads/11_June.pdf" 
    if os.path.exists(test_file):
        data = extract_bill_data(test_file)
        print("Final Extracted Data:", data)
    else:
        print(f"Place a file at {test_file} to test.")