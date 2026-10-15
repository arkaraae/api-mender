-- Who still calls an old API version: one row per caller, version, endpoint and outcome.
CREATE TABLE IF NOT EXISTS old_version_calls (
  api TEXT NOT NULL,
  caller TEXT NOT NULL,
  version TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (api, caller, version, endpoint, outcome)
);
