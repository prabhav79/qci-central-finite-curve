import os
import google.generativeai as genai
from dotenv import load_dotenv

# Force reload of .env
load_dotenv(override=True)

key = os.getenv("GOOGLE_API_KEY")
if key:
    print(f"Loaded Key: {key[:5]}...{key[-5:]}")
else:
    print("No GOOGLE_API_KEY found in environment.")

genai.configure(api_key=key)

print("Listing models...")
try:
    for m in genai.list_models():
        if 'generateContent' in m.supported_generation_methods:
            print(m.name)
            
    print("\nAttempting generation with gemini-2.0-flash-exp (or gemini-1.5-flash)...")
    # Try a known free model or the one requested
    model = genai.GenerativeModel("gemini-1.5-flash") 
    response = model.generate_content("Hello")
    print("Success:", response.text)
    
except Exception as e:
    print("\nERROR DETAILS:")
    print(e)
