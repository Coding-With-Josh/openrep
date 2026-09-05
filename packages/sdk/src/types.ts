export type AgentId = string;

export interface AgentManifest {
  id: AgentId;
  name: string;
  publicKey: string;
  createdAt: string;
  signature: string;
}

export interface Keypair {
  publicKey: string;
  privateKey: string;
}
