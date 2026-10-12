export const S3_MODEL_URL = 'https://raw.githubusercontent.com/aws/api-models-aws/main/models/s3/service/2006-03-01/s3-2006-03-01.json';
export const S3_MODEL_PAGE = 'https://github.com/aws/api-models-aws/blob/main/models/s3/service/2006-03-01/s3-2006-03-01.json';

type Shape = { type?: string; input?: { target?: string }; members?: Record<string, { target?: string; traits?: Record<string, unknown> }> };
export type SmithyModel = { smithy?: string; shapes?: Record<string, Shape> };
export type S3Operation = { name: string; inputMembers: string[]; requiredMembers: string[] };
export type S3ModelChange = { operation: string; member: string; kind: 'added' | 'removed' | 'required' | 'optional' | 'type_changed'; previousType?: string; currentType?: string };

export function readS3Operations(model: SmithyModel, names: string[]): S3Operation[] {
  if (!model || !model.shapes || typeof model.smithy !== 'string') throw new Error('AWS S3 model was incomplete');
  return names.map(name => {
    if (!/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name)) throw new Error('Invalid S3 operation name');
    const operation = model.shapes?.[`com.amazonaws.s3#${name}`];
    if (operation?.type !== 'operation' || typeof operation.input?.target !== 'string') throw new Error(`S3 operation ${name} was not in the official model`);
    const input = model.shapes?.[operation.input.target];
    if (input?.type !== 'structure' || !input.members) throw new Error(`S3 operation ${name} had no input structure`);
    const entries = Object.entries(input.members);
    return { name, inputMembers: entries.map(([member]) => member).sort(), requiredMembers: entries.filter(([, shape]) => Object.hasOwn(shape.traits || {}, 'smithy.api#required')).map(([member]) => member).sort() };
  });
}

export function compareS3Models(previous: SmithyModel, current: SmithyModel, names: string[]): S3ModelChange[] {
  const changes: S3ModelChange[] = [];
  for (const name of names) {
    readS3Operations(previous, [name]);
    readS3Operations(current, [name]);
    const beforeOp = previous.shapes![`com.amazonaws.s3#${name}`];
    const afterOp = current.shapes![`com.amazonaws.s3#${name}`];
    const before = previous.shapes![beforeOp.input!.target!]!.members!;
    const after = current.shapes![afterOp.input!.target!]!.members!;
    for (const member of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!before[member]) changes.push({ operation: name, member, kind: 'added', currentType: after[member]?.target });
      else if (!after[member]) changes.push({ operation: name, member, kind: 'removed', previousType: before[member]?.target });
      else {
        if (before[member].target !== after[member].target) changes.push({ operation: name, member, kind: 'type_changed', previousType: before[member].target, currentType: after[member].target });
        const wasRequired = Object.hasOwn(before[member].traits || {}, 'smithy.api#required');
        const isRequired = Object.hasOwn(after[member].traits || {}, 'smithy.api#required');
        if (wasRequired !== isRequired) changes.push({ operation: name, member, kind: isRequired ? 'required' : 'optional' });
      }
    }
  }
  return changes.sort((a, b) => `${a.operation}.${a.member}.${a.kind}`.localeCompare(`${b.operation}.${b.member}.${b.kind}`));
}

export async function fetchOfficialS3Model(): Promise<{ model: SmithyModel; sha256: string; retrievedAt: string }> {
  const response = await fetch(S3_MODEL_URL, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`AWS model fetch returned ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 6_000_000) throw new Error('AWS model exceeded the allowed size');
  const model = JSON.parse(new TextDecoder().decode(bytes)) as SmithyModel;
  if (!model.shapes || typeof model.smithy !== 'string') throw new Error('AWS model format was invalid');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  return { model, sha256, retrievedAt: new Date().toISOString() };
}
