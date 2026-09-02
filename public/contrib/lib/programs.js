// The machine's programs, defined once. The Apps box seeds from this list
// and tool-health probes it. Node loads it by relative path; the browser
// fetches it as /contrib/lib/programs.js. Starting content, not a lock
// (ADR-035, ADR-040).
export const PROGRAM_DEFAULTS = [
  { label: 'Extraction app', url: 'http://127.0.0.1:7860' },
  { label: 'EPUB extract', url: 'http://127.0.0.1:7861' },
  { label: 'Extraction review', url: 'http://127.0.0.1:7870' },
  { label: 'Promotion center', url: 'http://127.0.0.1:8860' },
  { label: 'Revision center', url: 'http://127.0.0.1:8880' }
];
