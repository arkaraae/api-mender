// Entry point for `node --test model-service/` from the repository root.
//
// Node >= 22 no longer recurses into a directory passed to `--test`; it
// resolves the directory like a package and runs its "main". package.json
// points "main" here so that command keeps working. Inside this directory,
// plain `node --test` (npm test) discovers the *.test.mjs files itself and
// does not pick this file up, so nothing runs twice.
import './gateway/server.test.mjs';
import './standin/server.test.mjs';
