from google.oauth2 import service_account
import vertexai
from vertexai.preview.generative_models import GenerativeModel
import time

SERVICE_ACCOUNT_FILE = "service_account.json"
PROJECT_ID = "qci-pmu-ocr"
LOCATIONS = ["us-central1", "us-east1", "asia-south1"]
MODELS = ["gemini-1.5-flash-001", "gemini-1.0-pro-001", "gemini-pro", "gemini-1.5-flash"]

credentials = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE)

with open("model_probe.log", "w") as f:
    for loc in LOCATIONS:
        f.write(f"\n--- Testing Location: {loc} ---\n")
        print(f"Testing {loc}...")
        try:
            vertexai.init(project=PROJECT_ID, location=loc, credentials=credentials)
            for m_name in MODELS:
                f.write(f"  Checking {m_name}...\n")
                try:
                    model = GenerativeModel(m_name)
                    response = model.generate_content("Test")
                    f.write(f"  SUCCESS: {m_name} works in {loc}!\n")
                    print(f"FOUND: {m_name} in {loc}")
                    break # Found one!
                except Exception as e:
                    f.write(f"  FAILED {m_name}: {str(e)[:100]}...\n")
        except Exception as e:
            f.write(f"  Failed init {loc}: {e}\n")
