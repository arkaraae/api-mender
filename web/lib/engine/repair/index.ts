// Bounded repair proposal: rules first, then at most one question to a
// self-hosted model, then the same deterministic gates for both. Customer
// source is never sent to a hosted AI provider (see model-client.ts), and a
// model never gets tools, a second attempt or more context than the task.
import type { Finding, LineEdit, ModelConfig, PolicyCheck, RepairAbstention, RepairMethod, RepairProposal, RepairResult } from '../types.ts';
import { bodyProperties } from './ast.ts';
import { splitLines } from './diff.ts';
import { ModelError, requestStructuredCompletion } from './model-client.ts';
import { ModelOutputError, parseModelDecision } from './output.ts';
import { evaluatePatch } from './policy.ts';
import { RESPONSE_SCHEMA, buildMessages } from './prompt.ts';
import { excerptContainsSecret } from './secrets.ts';
import { buildRepairTask, locateTargetCall } from './task.ts';
import type { RepairContract, SupportedRepairTask } from './task.ts';

export * from './diff.ts';
export * from './hosted-providers.ts';
export * from './model-client.ts';
export * from './output.ts';
export * from './policy.ts';
export * from './prompt.ts';
export * from './secrets.ts';
export * from './task.ts';

export type ProposeRepairInput = {
  finding: Finding; source: string; contract: RepairContract;
  model?: ModelConfig;
  /** False forbids the model path even when a model is configured. */
  allowModel?: boolean;
};

const STATIC_LIMIT = 'Static checks do not prove runtime behavior; run the project\'s tests against the new API version before merging.';
const MODEL_KINDS = ['request-property-removed', 'request-property-required', 'request-property-type-changed'];
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,119}$/;

function abstain(finding: Finding, stage: RepairAbstention['stage'], reason: string, policy?: PolicyCheck[]): RepairAbstention {
  return { schemaVersion: 1, findingId: finding.id, abstained: true, stage, reason, ...(policy ? { policy } : {}) };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The one mapping rules can prove: the new contract requires exactly one
 * field the call does not send, and the call sends exactly one field the new
 * contract does not accept. That is a rename of the key; the value is kept.
 */
export function deterministicRename(finding: Finding, source: string, contract: RepairContract): { edit: LineEdit; from: string; to: string } | null {
  if (finding.change.kind !== 'request-property-required' || !contract.acceptedProperties) return null;
  const call = locateTargetCall(finding, source);
  const properties = call && bodyProperties(source, call);
  if (!properties) return null;
  const sent = properties.map(item => item.name);
  const accepted = contract.acceptedProperties;
  const stale = sent.filter(name => !accepted.includes(name));
  const missing = contract.required.filter(name => !sent.includes(name));
  if (stale.length !== 1 || missing.length !== 1 || !accepted.includes(missing[0])) return null;
  const [from, to] = [stale[0], missing[0]];
  const key = properties.find(item => item.name === from)!.node.key;
  const hit = properties.find(item => item.name === from)!.node;
  const line = key.loc?.start?.line;
  if (!IDENTIFIER.test(from) || !IDENTIFIER.test(to) || typeof line !== 'number' || key.loc?.end?.line !== line) return null;
  const lines = splitLines(source);
  const lineStart = lines.slice(0, line - 1).reduce((offset, item) => offset + item.text.length + item.eol.length, 0);
  const text = lines[line - 1].text;
  const renamed = hit.shorthand ? `${to}: ${from}` : key.type === 'StringLiteral' ? JSON.stringify(to) : to;
  return { from, to, edit: { startLine: line, endLine: line,
    replacement: text.slice(0, key.start - lineStart) + renamed + text.slice(key.end - lineStart) } };
}

async function gated(input: ProposeRepairInput, task: SupportedRepairTask, edits: LineEdit[],
  method: RepairMethod, rationale: string, uncertainty: string[]): Promise<RepairResult> {
  const { finding, source, contract } = input;
  const verdict = evaluatePatch({ finding, task, contract, source, edits });
  if (!verdict.passed || verdict.afterSource === undefined || !verdict.diff) {
    const failed = verdict.checks.filter(check => !check.passed).map(check => check.name);
    return abstain(finding, 'policy-rejected', `The proposed patch failed policy gate(s): ${failed.join(', ')}`, verdict.checks);
  }
  return { schemaVersion: 1, findingId: finding.id, method,
    model: method === 'self-hosted-model' ? input.model!.model : null,
    file: task.file, edits, diff: verdict.diff,
    sourceSha256: await sha256(source), patchedSha256: await sha256(verdict.afterSource),
    policy: verdict.checks, rationale, uncertainty } satisfies RepairProposal;
}

async function modelRepair(input: ProposeRepairInput, task: SupportedRepairTask, model: ModelConfig): Promise<RepairResult> {
  const { finding } = input;
  // Checked before anything is sent. The reason names no content on purpose.
  if (excerptContainsSecret(task.excerpt))
    return abstain(finding, 'unsupported', 'The code around this call appears to contain a credential, so it was not sent to a model');
  let answer: unknown;
  try { answer = await requestStructuredCompletion(model, buildMessages(task), RESPONSE_SCHEMA); }
  catch (error) {
    if (error instanceof ModelError && error.kind === 'invalid-response') return abstain(finding, 'model-invalid-output', error.message);
    return abstain(finding, 'model-unavailable', error instanceof ModelError ? error.message : 'The model request failed');
  }
  let decision;
  try { decision = parseModelDecision(answer, task); }
  catch (error) {
    return abstain(finding, 'model-invalid-output', error instanceof ModelOutputError ? error.message : 'Model output is invalid');
  }
  if (decision.decision === 'abstain')
    return abstain(finding, 'model-abstained', decision.reason || 'The model abstained without giving a reason');
  // One attempt only: a rejected patch is never re-prompted with more context.
  return gated(input, task, decision.edits, 'self-hosted-model', decision.reason, [STATIC_LIMIT,
    'The mapping from old to new request values was chosen by a model and needs human review.',
    'The rationale is the model\'s own unverified text.']);
}

/** Propose one small, gated patch for a finding, or abstain with the reason. Never throws for model or patch problems. */
export async function proposeRepair(input: ProposeRepairInput): Promise<RepairResult> {
  const { finding, source, contract } = input;
  const task = buildRepairTask(finding, source, contract);
  if (!task.supported) return abstain(finding, 'unsupported', task.reason);
  const rename = deterministicRename(finding, source, contract);
  if (rename) {
    return gated(input, task, [rename.edit], 'deterministic',
      `Renamed request field "${rename.from}" to "${rename.to}": the only field sent that the new contract does not accept, and the only required field not sent.`,
      [STATIC_LIMIT, 'The rename assumes the new field carries the same value and meaning as the old one; the contract does not state that.']);
  }
  if (!MODEL_KINDS.includes(finding.change.kind))
    return abstain(finding, 'unsupported', 'No bounded repair strategy exists for this kind of change');
  if (input.allowModel === false)
    return abstain(finding, 'unsupported', 'Rules cannot settle this change and model use is disabled');
  if (!input.model)
    return abstain(finding, 'unsupported', 'Rules cannot settle this change kind; a self-hosted model endpoint is required');
  return modelRepair(input, task, input.model);
}
