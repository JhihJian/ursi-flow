import { isRecord, validateVariableName } from "ursi-flow-core/engine";

export interface NodeContract { outcomes: string[]; variables: string[] }

function nameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 256 && new Set(value).size === value.length &&
    value.every(item => typeof item === 'string' && item.trim());
}

export function parseNodeContract(value: unknown): NodeContract {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
    !nameList(value.outcomes) || !value.outcomes.length || !nameList(value.variables)) throw new Error('Invalid Flow node contract');
  value.variables.forEach(validateVariableName);
  return { outcomes: [...value.outcomes], variables: [...value.variables] };
}
