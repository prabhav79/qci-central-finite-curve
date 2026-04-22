"""Temporary probe: list embedding models + test common candidates.

Run via:  railway ssh -s backend -- python -m infra.seed._probe_embedding_models
Delete after use.
"""
import os
from google import genai

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

print("=== All models supporting embedContent ===")
try:
    for m in client.models.list():
        actions = getattr(m, "supported_actions", None) or []
        if any("embed" in str(x).lower() for x in actions):
            print(f"  {m.name:50s}  actions={actions}")
except Exception as e:
    print(f"list() failed: {type(e).__name__}: {e}")

print()
print("=== Trying candidate model ids against embed_content ===")
candidates = [
    "text-embedding-004",
    "models/text-embedding-004",
    "gemini-embedding-001",
    "models/gemini-embedding-001",
    "embedding-001",
    "models/embedding-001",
]
for cand in candidates:
    try:
        r = client.models.embed_content(model=cand, contents="hello world")
        dim = len(r.embeddings[0].values)
        print(f"  OK   {cand:40s} -> dim={dim}")
    except Exception as e:
        msg = str(e).splitlines()[0][:160]
        print(f"  FAIL {cand:40s} -> {type(e).__name__}: {msg}")
