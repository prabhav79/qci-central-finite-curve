from google.oauth2 import service_account
import vertexai
from vertexai.generative_models import GenerativeModel

SERVICE_ACCOUNT_FILE = "service_account.json"
PROJECT_ID = "qci-pmu-ocr"
LOCATION = "us-central1"

credentials = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE)
vertexai.init(project=PROJECT_ID, location=LOCATION, credentials=credentials)

print(f"Testing Vision Models in {LOCATION}...")

models = ["gemini-1.5-flash", "gemini-1.5-flash-001", "gemini-1.0-pro-vision-001"]

for m in models:
    try:
        model = GenerativeModel(m)
        response = model.generate_content("Hello")
        print(f"SUCCESS: {m} works!")
    except Exception as e:
        print(f"FAILED {m}: {str(e)[:100]}")
