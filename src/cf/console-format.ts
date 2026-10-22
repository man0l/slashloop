// The Workers runtime forwards console.* args to Workers Logs / log shipping
// without printf expansion, so the Prisma D1 adapter's
// `console.error("Error in performIO: %O", err)` lands as the literal `%O`
// with the DriverAdapterError detail dropped. Expand specs before the runtime
// sees them; calls without specs pass through untouched.

import { formatMessage, hasPrintfSpecs } from '../lib/format-log.js';

const PATCHED = Symbol.for('slashloop.console-spec-expansion');
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

export function installConsoleSpecExpansion(target: Console = console): void {
  const t = target as Console & { [PATCHED]?: boolean };
  if (t[PATCHED]) return;
  t[PATCHED] = true;
  for (const level of LEVELS) {
    const original = t[level].bind(t) as (...args: unknown[]) => void;
    t[level] = (...args: unknown[]) => {
      let out = args;
      if (hasPrintfSpecs(args)) {
        try {
          out = [formatMessage(args)];
        } catch {
          out = args;
        }
      }
      original(...out);
    };
  }
}
