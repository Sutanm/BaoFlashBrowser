import { describe, expect, it } from 'vitest';
import { validateWorkflowDocument, WorkflowValidationError, type WorkflowDocumentV3 } from '../src/shared/automation/core';

const literal = <T extends 'number' | 'boolean' | 'string'>(valueType: T, value: number | boolean | string) => ({ kind: 'literal' as const, valueType, value });
const document = (root: WorkflowDocumentV3['root']): WorkflowDocumentV3 => ({ formatVersion: 3, id: 'test', name: 'Test', root });

describe('Automation Runtime 2.0 workflow validation', () => {
  it('accepts typed variables and loop-scoped continue', () => {
    expect(() => validateWorkflowDocument(document({ id: 'root', kind: 'sequence', nodes: [
      { id: 'let', kind: 'let', name: 'count', valueType: 'number', value: literal('number', 0) },
      { id: 'loop', kind: 'loop', mode: 'repeat', count: literal('number', 3), body: { id: 'body', kind: 'sequence', nodes: [
        { id: 'set', kind: 'set', name: 'count', value: { kind: 'binary', valueType: 'number', operator: 'add', left: { kind: 'variable', valueType: 'number', name: 'count' }, right: literal('number', 1) } },
        { id: 'continue', kind: 'continue' },
      ] } },
    ] }))).not.toThrow();
  });

  it.each(['break', 'continue'] as const)('rejects %s outside a loop', (kind) => {
    expect(() => validateWorkflowDocument(document({ id: 'root', kind }))).toThrowError(WorkflowValidationError);
    try { validateWorkflowDocument(document({ id: 'root', kind })); } catch (error) { expect((error as WorkflowValidationError).code).toBe('CONTROL_SCOPE_INVALID'); }
  });

  it('rejects duplicate node ids', () => {
    expect(() => validateWorkflowDocument(document({ id: 'same', kind: 'sequence', nodes: [{ id: 'same', kind: 'sequence', nodes: [] }] }))).toThrow('duplicate node id');
  });

  it('rejects use-before-declaration and type mismatch', () => {
    const root = { id: 'root', kind: 'sequence' as const, nodes: [
      { id: 'set', kind: 'set' as const, name: 'missing', value: literal('number', 1) },
    ] };
    expect(() => validateWorkflowDocument(document(root))).toThrow('undeclared variable');
  });

  it('enforces structural budgets before execution', () => {
    expect(() => validateWorkflowDocument(document({ id: 'root', kind: 'sequence', nodes: [
      { id: 'child', kind: 'sequence', nodes: [] },
    ] }), { maxNodes: 1 })).toThrow('workflow nodes exceed');
  });

  it('rejects non-finite literals and oversized strings', () => {
    expect(() => validateWorkflowDocument(document({ id: 'root', kind: 'let', name: 'n', valueType: 'number', value: literal('number', Number.NaN) }))).toThrow('finite');
    expect(() => validateWorkflowDocument(document({ id: 'root', kind: 'let', name: 's', valueType: 'string', value: literal('string', 'abcd') }), { maxStringLength: 3 })).toThrow('string literal budget');
  });
});
