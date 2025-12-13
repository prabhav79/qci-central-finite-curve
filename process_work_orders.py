import os
import glob
from google.cloud import vision
from pdf2image import convert_from_path

# 1. SETUP CREDENTIALS
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "credentials.json"

# 2. SETUP POPPLER PATH (Matches ocr.py)
POPPLER_PATH = r"C:\poppler\Library\bin"

INPUT_DIR = os.path.join("data", "raw")
OUTPUT_DIR = os.path.join("data", "extracted_text") # Saving extracted text here

def convert_pdf_to_images(pdf_path):
    try:
        # Convert PDF to images
        pages = convert_from_path(pdf_path, poppler_path=POPPLER_PATH)
        temp_paths = []
        for i, page in enumerate(pages):
            temp_name = f"temp_page_{i}.jpg"
            page.save(temp_name, 'JPEG')
            temp_paths.append(temp_name)
        return temp_paths
    except Exception as e:
        print(f"❌ PDF Conversion Error for {pdf_path}: {e}")
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

def process_all_pdfs():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        print(f"Created output directory: {OUTPUT_DIR}")

    pdf_files = glob.glob(os.path.join(INPUT_DIR, "*.pdf"))
    
    if not pdf_files:
        print(f"No PDF files found in {INPUT_DIR}")
        return

    print(f"Found {len(pdf_files)} PDFs to process.")

    for pdf_file in pdf_files:
        print(f"\nProcessing: {pdf_file}")
        
        # 1. Convert to Images
        image_paths = convert_pdf_to_images(pdf_file)
        
        if not image_paths:
            print("Skipping (Conversion Failed or Empty)")
            continue

        full_text = ""
        
        # 2. OCR each image
        for img in image_paths:
            print(f"  - OCR on {img}...")
            text = process_image_with_google(img)
            full_text += text + "\n"
            
            # Clean up temp image
            if os.path.exists(img):
                os.remove(img)

        # 3. Save Text
        filename = os.path.basename(pdf_file)
        text_filename = os.path.splitext(filename)[0] + ".txt"
        output_path = os.path.join(OUTPUT_DIR, text_filename)
        
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(full_text)
            
        print(f"✅ Saved text to: {output_path}")

if __name__ == "__main__":
    process_all_pdfs()
