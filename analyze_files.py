import os
import glob
import fitz  # PyMuPDF

def analyze_pdfs():
    raw_dir = "data/raw"
    files = glob.glob(os.path.join(raw_dir, "*.pdf"))
    
    print(f"{'Filename':<50} | {'Pages':<5} | {'Text Chars':<10} | {'Type'}")
    print("-" * 80)
    
    for file_path in files:
        doc = fitz.open(file_path)
        text_len = 0
        for page in doc:
            text_len += len(page.get_text())
            
        doc_type = "Digital" if text_len / len(doc) > 100 else "Scan/Image"
        
        print(f"{os.path.basename(file_path):<50} | {len(doc):<5} | {text_len:<10} | {doc_type}")

if __name__ == "__main__":
    analyze_pdfs()
