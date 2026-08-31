import type { Generated } from 'kysely';

export type ProjectTable = {
  id: string;
  name: string;
  description: string | null;
  root_path: string;
  created_at: string;
  updated_at: string;
};

export type ConversationTable = {
  id: string;
  project_id: string | null;
  workspace_scope: string;
  title: string;
  kind: string;
  schema_version: number;
  conversation_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type RunTable = {
  id: string;
  conversation_id: string | null;
  saved_dag_id: string | null;
  orchestration_session_id: string | null;
  target_json: string;
  input_json: string;
  checkpoint_json: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type SavedDagTable = {
  id: string;
  project_id: string | null;
  name: string;
  description: string;
  graph_json: string;
  layout_json: string;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OrchestrationSessionTable = {
  id: string;
  conversation_id: string;
  project_id: string;
  kind: string;
  saved_dag_id: string | null;
  draft_graph_json: string | null;
  ui_state_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type RunEventTable = {
  id: Generated<number>;
  run_id: string;
  sequence: number;
  type: string;
  payload_json: string;
  created_at: string;
};

export type SettingTable = {
  key: string;
  value_json: string;
  updated_at: string;
};

export type LeaseTable = {
  resource: string;
  holder: string;
  expires_at: string;
};

export type AgentTable = {
  id: string;
  config_json: string;
  created_at: string;
  updated_at: string;
};

export type ModelProviderTable = {
  id: string;
  name: string;
  source: string;
  base_url: string;
  model: string;
  api_key: string | null;
  api_key_env: string | null;
  timeout_ms: number;
  context_window_tokens: number;
  output_reserve_tokens: number;
  reasoning_json: string;
  stream_include_usage: number;
  extra_request_args_json: string;
  extra_body_json: string;
  active: number;
  created_at: string;
  updated_at: string;
};

export type McpServerTable = {
  name: string;
  config_json: string;
  created_at: string;
  updated_at: string;
};

export type CapabilityModuleTable = {
  id: string;
  source: string;
  path: string;
  exports_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type TemplateCapabilityTable = {
  id: string;
  config_json: string;
  created_at: string;
  updated_at: string;
};

export interface DatabaseSchema {
  projects: ProjectTable;
  conversations: ConversationTable;
  runs: RunTable;
  saved_dags: SavedDagTable;
  orchestration_sessions: OrchestrationSessionTable;
  run_events: RunEventTable;
  settings: SettingTable;
  leases: LeaseTable;
  agents: AgentTable;
  model_providers: ModelProviderTable;
  mcp_servers: McpServerTable;
  capability_modules: CapabilityModuleTable;
  template_capabilities: TemplateCapabilityTable;
}
