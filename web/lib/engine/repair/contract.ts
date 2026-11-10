// The deterministic contract facts the repair gates check a patch against,
// read straight from the NEW version's operation slice. Nothing here comes
// from the model, the repository or provider prose.
import type { ContractChange, OperationSlice } from '../types.ts';
import { requestSchemaOf } from '../openapi-slice.ts';
import type { RepairContract } from './task.ts';

const name = /^[A-Za-z_$][\w$.-]{0,127}$/;

export function repairContractFor(change: ContractChange, newSlice: OperationSlice | null): RepairContract {
  const removed = change.kind === 'request-property-removed' ? change.fields.filter(field => name.test(field)) : [];
  const schema = newSlice ? requestSchemaOf(newSlice) : null;
  if (!schema) return { acceptedProperties: null, required: [], removed };
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? Object.keys(schema.properties as object).filter(key => name.test(key)) : null;
  // The listed properties are used as the accepted set even when the schema
  // does not say additionalProperties: false. That is deliberately strict: a
  // patch may only send keys the provider documents. A schema with no
  // property list says nothing, so that gate is skipped rather than guessed.
  const closed = properties !== null && properties.length > 0;
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((field): field is string => typeof field === 'string' && name.test(field)) : [];
  return { acceptedProperties: closed ? properties.slice(0, 500) : null, required: required.slice(0, 100), removed };
}
