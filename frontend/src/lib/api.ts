import { getToken, clearToken } from "./auth";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export type DocType = "work_order" | "proposal";

export interface SourceRef {
  doc_id: string;
  document_id: string;
  chunk_index: number;
  text?: string;
  similarity: number;
  ministry?: string;
  project?: string;
  issued_on?: string;
  blob_key?: string;
}

export type RetrievedChunk = SourceRef;

export interface SearchParams {
  q: string;
  ministry?: string[];
  min_value?: number;
  max_value?: number;
  start_date?: string;
  end_date?: string;
}

export interface SearchResponse {
  results: RetrievedChunk[];
  count: number;
}

export interface FilterMetadata {
  ministries: string[];
  value_range: {
    min: number;
    max: number;
  };
}

export interface IngestJobResponse {
  id: string;
  total_files: number;
  status: string;
}

export interface IngestItem {
  id: string;
  source_filename: string;
  status: "queued" | "processing" | "ready" | "failed";
  error: string | null;
}

export interface IngestStatus {
  id: string;
  started_at: string;
  finished_at: string | null;
  total_files: number;
  completed: number;
  failed: number;
  items: IngestItem[];
}

export interface GenerateResponse {
  id: string;
  doc_type: DocType;
  draft_md: string;
  sources: SourceRef[];
  model_used: string;
  retrieval_count: number;
  retry_count: number;
}

export interface DemoLoginResponse {
  token: string;
  expires_at: string;
  subject: string;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  
  const headers = new Headers(options.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (options.body && !(options.body instanceof Blob)) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    clearToken();
    if (typeof window !== "undefined") {
      window.location.href = "/";
    }
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(errorBody.detail || `Request failed with status ${response.status}`);
  }

  // Handle binary responses (export)
  const contentType = response.headers.get("Content-Type");
  if (contentType?.includes("application/vnd.openxmlformats-officedocument")) {
    return (await response.blob()) as T;
  }

  return response.json();
}

export const api = {
  async login(password: string): Promise<DemoLoginResponse> {
    return request<DemoLoginResponse>("/auth/demo-login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  },

  async generate(prompt: string, doc_type: DocType, top_k?: number): Promise<GenerateResponse> {
    return request<GenerateResponse>("/generate", {
      method: "POST",
      body: JSON.stringify({ prompt, doc_type, top_k }),
    });
  },

  async getGeneration(id: string): Promise<GenerateResponse> {
    return request<GenerateResponse>(`/generate/${id}`);
  },

  async exportDocx(id: string, draft_md?: string): Promise<Blob> {
    return request<Blob>(`/generate/${id}/export`, {
      method: "POST",
      body: JSON.stringify({ draft_md }),
    });
  },

  async search(params: SearchParams): Promise<SearchResponse> {
    const searchParams = new URLSearchParams({ q: params.q });
    if (params.ministry) {
      params.ministry.forEach(m => searchParams.append("ministry", m));
    }
    if (params.min_value !== undefined) searchParams.append("min_value", params.min_value.toString());
    if (params.max_value !== undefined) searchParams.append("max_value", params.max_value.toString());
    if (params.start_date) searchParams.append("start_date", params.start_date);
    if (params.end_date) searchParams.append("end_date", params.end_date);

    return request<SearchResponse>(`/search?${searchParams.toString()}`);
  },

  async getSearchFilters(): Promise<FilterMetadata> {
    return request<FilterMetadata>("/search/filters");
  },

  async ingestFiles(files: File[]): Promise<IngestJobResponse> {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file));
    
    return request<IngestJobResponse>("/ingest", {
      method: "POST",
      body: formData,
    });
  },

  async getIngestStatus(jobId: string): Promise<IngestStatus> {
    return request<IngestStatus>(`/ingest/${jobId}`);
  },
  
  async checkHealth() {
    return request<{ ok: boolean; version: string }>("/health");
  }
};
