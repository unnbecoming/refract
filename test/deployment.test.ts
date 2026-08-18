import * as fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseAllDocuments } from 'yaml';

function documents(file: string): Array<Record<string, unknown>> {
  return parseAllDocuments(fs.readFileSync(file, 'utf8')).map((document) => document.toJSON() as Record<string, unknown>);
}
function at(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

describe('deployment boundary', () => {
  test('uses one non-overlapping, non-root, read-only SQLite writer with split mounts and probes', () => {
    const docs = documents('kubernetes/refract.yaml');
    expect(docs.some((doc) => doc.kind === 'Secret')).toBe(false);
    const deployment = docs.find((doc) => doc.kind === 'Deployment');
    expect(at(deployment, ['spec', 'replicas'])).toBe(1);
    expect(at(deployment, ['spec', 'strategy', 'type'])).toBe('Recreate');
    expect(at(deployment, ['spec', 'template', 'spec', 'automountServiceAccountToken'])).toBe(false);
    expect(at(deployment, ['spec', 'template', 'spec', 'securityContext'])).toMatchObject({ runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001 });
    expect(at(deployment, ['spec', 'template', 'spec', 'containers', 0, 'securityContext'])).toMatchObject({ readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
    expect(at(deployment, ['spec', 'template', 'spec', 'containers', 0, 'startupProbe', 'httpGet', 'path'])).toBe('/health/live');
    expect(at(deployment, ['spec', 'template', 'spec', 'containers', 0, 'readinessProbe', 'httpGet', 'path'])).toBe('/health/ready');
    expect(JSON.stringify(at(deployment, ['spec', 'template', 'spec', 'containers', 0, 'volumeMounts']))).toContain('"readOnly":true');
    expect(JSON.stringify(at(deployment, ['spec', 'template', 'spec', 'volumes']))).toContain('"sizeLimit":"3Gi"');
    expect(String(at(deployment, ['spec', 'template', 'spec', 'containers', 0, 'image']))).not.toContain(':latest');
    const servicePorts = docs.filter((doc) => doc.kind === 'Service').map((doc) => at(doc, ['spec', 'ports', 0, 'port']));
    expect(servicePorts.sort()).toEqual([8340, 8341]);
  });
  test('keeps agent egress on the data port and operator ingress on the distinct admin port', () => {
    const policies = documents('kubernetes/network-policy.yaml');
    expect(policies.some((doc) => at(doc, ['metadata', 'name']) === 'default-deny' && JSON.stringify(at(doc, ['spec', 'podSelector'])) === '{}')).toBe(true);
    const text = fs.readFileSync('kubernetes/network-policy.yaml', 'utf8');
    expect(text).toContain('port: 8340');
    expect(text).toContain('port: 8341');
    expect(text).toContain('port: 443');
    const agentEgress = policies.find((doc) => at(doc, ['metadata', 'name']) === 'agent-egress');
    expect(JSON.stringify(agentEgress)).not.toContain('8341');
  });
  test('container pins Node 22 and changes to the fixed unprivileged user', () => {
    const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
    expect(dockerfile.match(/FROM node:22-bookworm-slim/g)).toHaveLength(2);
    expect(dockerfile).toContain('npm ci');
    expect(dockerfile).toContain('USER 10001:10001');
  });
});
