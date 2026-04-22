"""Probe: which Flash-class generation models are available on this API key?

Run via:  railway ssh -s backend -- python -m infra.seed._probe_generation_models
Delete after use.
"""
import os

from google import genai

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

print("=== All models supporting generateContent ===")
flash_models: list[str] = []
try:
    for m in client.models.list():
        actions = getattr(m, "supported_actions", None) or []
        if "generateContent" in actions:
            tag = ""
            lname = m.name.lower()
            if "flash" in lname:
                tag = "  <-- FLASH"
                flash_models.append(m.name)
            print(f"  {m.name:55s}  actions={actions}{tag}")
except Exception as e:
    print(f"list() failed: {type(e).__name__}: {e}")

print()
print("=== Smoke-test top Flash candidates with a 1-token generate ===")
# Try newest first; stop at first success.
priority = [
    "models/gemini-2.5-flash",
    "models/gemini-2.0-flash",
    "models/gemini-2.0-flash-exp",
    "models/gemini-2.0-flash-lite",
    "models/gemini-1.5-flash",
    "models/gemini-1.5-flash-8b",
]
tested = set()
for cand in priority + flash_models:
    cand = cand if cand.startswith("models/") else f"models/{cand}"
    if cand in tested:
        continue
    tested.add(cand)
    try:
        r = client.models.generate_content(
            model=cand,
            contents="Say OK and nothing else.",
        )
        txt = (r.text or "").strip().splitlines()[0] if r.text else "(empty)"
        print(f"  OK    {cand:45s} -> {txt!r}")
    except Exception as e:
        msg = str(e).splitlines()[0][:150]
        print(f"  FAIL  {cand:45s} -> {type(e).__name__}: {msg}")
