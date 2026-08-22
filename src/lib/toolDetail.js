// The one argument worth showing next to a tool's name, in the order Claude
// Code's own tools name them. Its own module because both transcript readers
// need exactly this list and differ only in whether they cap the result -
// public/js/subagents.js mirrors it a third time, out of reach of an import.
const DETAIL_KEYS = ['command', 'file_path', 'pattern', 'path', 'url', 'description'];

export function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of DETAIL_KEYS) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
}
