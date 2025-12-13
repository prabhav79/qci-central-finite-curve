import os
import google.generativeai as genai
from dotenv import load_dotenv
import time

load_dotenv(override=True)
genai.configure(api_key=os.getenv("GOOGLE_API_KEY"))

print("Searching for a working model...")
working_model = None

for m in genai.list_models():
    if 'generateContent' in m.supported_generation_methods:
        print(f"Testing {m.name}...")
        try:
            model = genai.GenerativeModel(m.name)
            response = model.generate_content("Test")
            print(f"SUCCESS: {m.name} works!")
            working_model = m.name
            break
        except Exception as e:
            print(f"FAILED: {m.name} - {str(e)[:100]}...")
        time.sleep(1)

if working_model:
    print(f"\nRECOMMENDATION: Use {working_model}")
else:
    print("\nNO WORKING MODELS FOUND.")
