// human readable stdout blocks for score and resolve results. create, attest,
// and ingest print machine readable json instead, so pipelines can consume
// signed records; score/resolve are meant for eyeballs.

import type { AgentScore, ResolvedManifest } from "@openrep/sdk";

export function printScoreBlock(publicKey: string, name: string, score: AgentScore): void {
  console.log(`agent:      ${publicKey}`);
  console.log(`name:       ${name}`);
  console.log(`composite:  ${score.composite}`);
  console.log(`computedAt: ${score.computedAt}`);
  if (score.breakdown.length === 0) {
    console.log("breakdown:  (no attestations yet; composite is 0)");
    return;
  }
  console.log("breakdown:");
  for (const entry of score.breakdown) {
    console.log(
      `  ${entry.source.padEnd(16)} value=${entry.value} count=${entry.count} lastUpdated=${entry.lastUpdated}`,
    );
  }
}

export function printManifestBlock(manifest: ResolvedManifest): void {
  console.log(`name:            ${manifest.name}`);
  console.log(`publicKey:       ${manifest.publicKey}`);
  console.log(`ownerPublicKey:  ${manifest.ownerPublicKey ?? "(legacy row, not revocable)"}`);
  console.log(`manifestVersion: ${manifest.manifestVersion}`);
  console.log(`createdAt:       ${manifest.createdAt}`);
  console.log(`memoryPointer:   ${manifest.memoryPointer ?? "-"}`);
  console.log(`permissions:     ${manifest.permissions.join(", ")}`);
  console.log(`revokedAt:       ${manifest.revokedAt ?? "-"}`);
  console.log(`signature:       ${manifest.signature}`);
}