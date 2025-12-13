from pydantic import BaseModel, Field
from typing import List, Optional, Any

class TableData(BaseModel):
    table_id: int
    data: str = Field(description="JSON string representation of the table data (e.g. List[List] or List[Dict])")
    description: Optional[str] = None

class GraphNode(BaseModel):
    source: str
    target: str
    relation: str
    weight: int = 1

class WorkOrderMeta(BaseModel):
    ministry: str
    date: Optional[str]
    value_inr: Optional[float]
    domains: List[str] = Field(description="Tags like 'Urban Planning', 'Smart Cities', etc.")
    doc_id: Optional[str] = None

class WorkOrderContent(BaseModel):
    full_text: str
    tables: List[TableData]

class WorkOrderDocument(BaseModel):
    doc_id: str
    meta: WorkOrderMeta
    content: WorkOrderContent
    graph_nodes: List[GraphNode]
