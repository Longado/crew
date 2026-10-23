export type SecurityState = 'waiting_input' | 'waiting_approval' | 'running' | 'completed' | 'cancelled' | 'expired' | 'failed';
export interface CredentialSummary {
  id: string;
  name: string;
  usageInstructions: string;
  environmentVariables: string[];
  canProbe: boolean;
  storage?: 'macos-keychain';
  runnable?: true;
  usage?: CredentialUsage;
}
export interface CredentialUsage {
  approved: number;
  denied: number;
  timeout: number;
  unavailable: number;
  lastAt: string;
  lastResult: string;
  lastInitiator: string;
}
// Explicit browser projection: private process-chain/environment fields never leave the reader.
export interface CredentialDecision {
  time: string;
  credentialId: string;
  credentialName: string;
  initiator: string;
  result: 'approved' | 'denied' | 'timeout' | 'unavailable';
  command: string;
  cwd: string;
}
export interface RecentCredentialUsage {
  status: 'available' | 'unavailable' | 'absent';
  decisions: CredentialDecision[];
  lastDecisionAt: Record<string,string>;
  skippedLines: number;
  truncated: boolean;
}
export interface CredentialCatalog {
  status: 'available' | 'unavailable';
  testOnly: true;
  nativeAvailable?: boolean;
  scanAvailable?: boolean;
  localStore?: {status: 'available' | 'unavailable' | 'absent'; count: number; usage?: 'unavailable'};
  credentials: CredentialSummary[];
  recentUsage?: RecentCredentialUsage;
  message?: string;
}
export interface SecurityFinding {
  path: string;
  line: number | null;
  column?: number | null;
  rule: string;
  rules: string[];
  priority: 'high' | 'review' | 'low';
}
export interface SecurityScanResult {
  scannedAt: string;
  checkedFiles: number;
  complete: boolean;
  findings: SecurityFinding[];
  summary: { high: number; review: number; low: number };
  coverageNotes: string[];
}
export interface SecurityOperation {
  id: string;
  kind: 'local_input' | 'env_presence' | 'project_scan';
  projectId?: string;
  state: SecurityState;
  createdAt: string;
  updatedAt: string;
  progress?: { checkedFiles: number; findings: number };
  result?: { credential?: { id: string; name: string }; present?: boolean; scan?: SecurityScanResult };
  error?: { code: string; message: string };
}
export interface SecurityService {
  listCredentials(): Promise<CredentialCatalog>;
  requestInput(input: { provider: 'ark'; projectId?: string }): Promise<SecurityOperation>;
  probe(input: { credentialId: string; projectId?: string }): Promise<SecurityOperation>;
  startScan(input: { projectId: string; directory: string }): Promise<SecurityOperation>;
  getOperation(id: string, projectId?: string): Promise<SecurityOperation | undefined>;
  cancelOperation(id: string, projectId?: string): Promise<SecurityOperation | undefined>;
  latestScan(projectId: string): SecurityOperation | undefined;
  close(): Promise<void>;
}
