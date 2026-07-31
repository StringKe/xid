export function hasGeneratedDocsBase(source: string): boolean {
  return /\bbase\s*:\s*(['"])generated\/docs\1/u.test(source)
}
