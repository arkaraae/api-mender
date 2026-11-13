// One parse for JavaScript and TypeScript sources. JSX and TypeScript's
// `<Type>value` casts cannot both be read in one grammar, so a source that
// fails with JSX enabled (a .ts file using angle-bracket casts) is read again
// without it. Repository content is parsed, never run.
import { parse, type ParserOptions } from '@babel/parser';

export function parseModule(source: string, options: Omit<ParserOptions, 'plugins' | 'sourceType'> = {}) {
  try { return parse(source, { ...options, sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] }); }
  catch (error) {
    try { return parse(source, { ...options, sourceType: 'unambiguous', plugins: ['typescript'] }); }
    catch { throw error; }
  }
}
