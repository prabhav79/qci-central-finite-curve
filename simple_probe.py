from google.oauth2 import service_account
import vertexai
from vertexai.generative_models import GenerativeModel

SERVICE_ACCOUNT_FILE = "service_account.json"
PROJECT_ID = "qci-pmu-ocr"
LOCATION = "us-central1"

credentials = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE)
vertexai.init(project=PROJECT_ID, location=LOCATION, credentials=credentials)

print(f"Testing {LOCATION}...")
try:
    model = GenerativeModel("gemini-1.0-pro")
    response = model.generate_content("Hello")
    print("SUCCESS: gemini-1.0-pro works!")
except Exception as e:
    print(f"FAILED gemini-1.0-pro: {e}")
