import os
import json
from models import WorkOrderDocument


def save_json(data: WorkOrderDocument, output_dir: str):
    """
    Save the WorkOrderDocument to a JSON file.
    Compatible with both Pydantic v1 and v2.
    """
    output_path = os.path.join(output_dir, f"{data.doc_id}.json")
    os.makedirs(output_dir, exist_ok=True)

    if hasattr(data, "model_dump"):
        # Pydantic v2
        data_dict = data.model_dump()
    else:
        # Pydantic v1
        data_dict = data.dict()

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data_dict, f, indent=2, default=str)

    print(f"  💾 Saved: {output_path}")
