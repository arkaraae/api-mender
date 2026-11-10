import assert from 'node:assert/strict';
import test from 'node:test';

import { PatchValidationError, validateDiff } from '../src/runner/patch.mjs';
import { FIX_PATCH, SOURCE_FILE } from './fixtures/runner/helpers.mjs';

const hunk = '@@ -1,1 +1,1 @@\n-a\n+b\n';
const rejects = (diff, file, pattern) =>
  assert.throws(() => validateDiff(diff, file), (error) => error instanceof PatchValidationError && pattern.test(error.message), `${pattern}`);

test('accepts a plain single-file diff, with or without the git header', () => {
  validateDiff(FIX_PATCH, SOURCE_FILE);
  validateDiff(`--- a/x.js\n+++ b/x.js\n${hunk}`, 'x.js');
  validateDiff(`diff --git a/x.js b/x.js\nindex 1234abc..5678def 100644\n--- a/x.js\n+++ b/x.js\n${hunk}`, 'x.js');
  validateDiff(`--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n`, 'x.js');
});

test('a removed line that looks like a file header is still content', () => {
  validateDiff('--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,1 @@\n--- a/y.js\n keep\n', 'x.js');
});

test('rejects diffs that touch two files', () => {
  rejects(`--- a/x.js\n+++ b/x.js\n${hunk}--- a/y.js\n+++ b/y.js\n${hunk}`, 'x.js', /more than one file/);
  rejects(`diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n${hunk}diff --git a/y.js b/y.js\n--- a/y.js\n+++ b/y.js\n${hunk}`, 'x.js', /more than one file/);
});

test('rejects renames and copies', () => {
  rejects('diff --git a/x.js b/x.js\nsimilarity index 100%\nrename from x.js\nrename to y.js\n', 'x.js', /renames and copies/);
  rejects(`diff --git a/x.js b/y.js\n--- a/x.js\n+++ b/y.js\n${hunk}`, 'x.js', /does not name only/);
  rejects(`--- a/x.js\n+++ b/y.js\n${hunk}`, 'x.js', /"\+\+\+" header names/);
  rejects(`diff --git a/x.js b/x.js\ncopy from x.js\ncopy to z.js\n--- a/x.js\n+++ b/x.js\n${hunk}`, 'x.js', /renames and copies/);
});

test('rejects path traversal, absolute paths and .git paths', () => {
  rejects(`--- a/../../etc/passwd\n+++ b/../../etc/passwd\n${hunk}`, '../../etc/passwd', /traversal/);
  rejects(`--- a/../../etc/passwd\n+++ b/../../etc/passwd\n${hunk}`, 'x.js', /header names/);
  rejects(`--- a/src/../../x\n+++ b/src/../../x\n${hunk}`, 'src/../../x', /traversal/);
  rejects(`--- /etc/passwd\n+++ /etc/passwd\n${hunk}`, '/etc/passwd', /absolute/);
  rejects(`--- /etc/passwd\n+++ /etc/passwd\n${hunk}`, 'x.js', /header names/);
  rejects(`--- a/.git/hooks/pre-commit\n+++ b/.git/hooks/pre-commit\n${hunk}`, '.git/hooks/pre-commit', /\.git/);
  rejects(`--- a/sub/.GIT/config\n+++ b/sub/.GIT/config\n${hunk}`, 'sub/.GIT/config', /\.git/);
  rejects(`--- a/./x.js\n+++ b/./x.js\n${hunk}`, './x.js', /normalised/);
});

test('rejects mode changes, new/deleted files and binary patches', () => {
  rejects(`diff --git a/x.js b/x.js\nold mode 100644\nnew mode 100755\n--- a/x.js\n+++ b/x.js\n${hunk}`, 'x.js', /mode changes/);
  rejects(`diff --git a/x.js b/x.js\nnew file mode 100755\n--- /dev/null\n+++ b/x.js\n@@ -0,0 +1 @@\n+b\n`, 'x.js', /creating or deleting/);
  rejects(`--- /dev/null\n+++ b/x.js\n@@ -0,0 +1 @@\n+b\n`, 'x.js', /\/dev\/null/);
  rejects(`--- a/x.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n`, 'x.js', /\/dev\/null/);
  rejects('diff --git a/x.js b/x.js\nindex 1234abc..5678def 100644\nGIT binary patch\nliteral 3\nKcmZQzU|?VY0RR910RR91\n', 'x.js', /binary/);
  rejects('diff --git a/x.js b/x.js\nBinary files a/x.js and b/x.js differ\n', 'x.js', /binary/);
});

test('rejects a diff for a different file than expected', () => {
  rejects(FIX_PATCH, 'src/other.mjs', /does not name only/);
  rejects(`--- a/y.js\n+++ b/y.js\n${hunk}`, 'x.js', /header names/);
});

test('rejects malformed hunks, trailing content and oversized or empty input', () => {
  rejects('--- a/x.js\n+++ b/x.js\n', 'x.js', /no hunks/);
  rejects('--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n-a\n+b\n', 'x.js', /middle of a hunk/);
  rejects(`--- a/x.js\n+++ b/x.js\n${hunk}garbage\n`, 'x.js', /after the last hunk/);
  rejects(`some preamble\n--- a/x.js\n+++ b/x.js\n${hunk}`, 'x.js', /expected "--- a\/x.js"/);
  rejects('', 'x.js', /empty/);
  rejects(`--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,1 @@\n-a\n+b\0\n`, 'x.js', /NUL/);
  rejects(`--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+${'b'.repeat(1024 * 1024)}\n`, 'x.js', /larger than/);
});
