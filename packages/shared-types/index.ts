export type CfcRole =
  | "apex"
  | "admin"
  | "l2_approver"
  | "l1_approver"
  | "maker"
  | "reader";

export type SuperDocRole = "editor" | "suggester" | "viewer";
export type DocumentMode = "editing" | "suggesting" | "viewing";
export type AgentChangeMode = "direct" | "tracked";

export type DraftStatus =
  | "DRAFT"
  | "PENDING_L1_REVIEW"
  | "APPROVED_L1_PENDING_L2"
  | "FINAL_APPROVED"
  | "REJECTED"
  | "CHANGES_REQUESTED";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  designation?: string;
  cfc_role: CfcRole;
}

export interface DraftSession {
  draft_id: string;
  user: SessionUser;
  superdoc_role: SuperDocRole;
  document_mode: DocumentMode;
  can_save: boolean;
  can_submit: boolean;
  can_decide_l1: boolean;
  can_decide_l2: boolean;
  can_run_agent_mutate: boolean;
  agent_change_mode: AgentChangeMode;
  status: DraftStatus;
  version: number;
}

export interface DraftVersionInfo {
  version: number;
  trigger: string;
  sha256?: string;
  created_at: string;
  path?: string;
}
