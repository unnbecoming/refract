export interface BuildInfo {
  name: 'refract';
  phase: 0;
}

export function buildInfo(): BuildInfo {
  return { name: 'refract', phase: 0 };
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  process.stdout.write(`${JSON.stringify(buildInfo())}\n`);
}
