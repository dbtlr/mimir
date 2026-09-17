import { sandboxAuthorityFromEnvironment } from '../src/sandbox-authority';
import { buildStore } from '../src/store-backend';
import { seedWorkingSet } from '../src/testing/conformance';

// This worker is only launched with a generated sandbox authority, never a URL.
if (sandboxAuthorityFromEnvironment() === undefined) {
  throw new Error('A launcher-owned sandbox is required.');
}
const operation = process.argv[2];
if (operation !== 'seed' && operation !== 'verify') {
  throw new Error('Expected seed or verify.');
}
const built = await buildStore();
try {
  if (operation === 'seed') {
    await seedWorkingSet(built.store);
  }
  const diagnosis = await built.doctor.diagnose(undefined);
  if (diagnosis.findings.length > 0) {
    throw new Error(`Sandbox verification found ${diagnosis.findings.length} integrity problems.`);
  }
  const exported = await built.store.export();
  const working = await built.store.loadWorkingSet();
  if (operation === 'seed' && (working.projects.length !== 2 || working.nodes.length !== 4)) {
    throw new Error('Sandbox fixture does not match the expected two projects and four nodes.');
  }
  process.stdout.write(
    `${JSON.stringify({ exportVersion: exported.schema_version, findings: diagnosis.findings.length, fixtureRevision: operation === 'seed' ? 1 : undefined, nodes: working.nodes.length, projects: working.projects.length })}\n`,
  );
} finally {
  await built.close();
}
