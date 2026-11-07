-- Daily limits (lib/mender/limits.js): one row per day and bucket ("watch", "watch:<visitor>", …).
CREATE TABLE IF NOT EXISTS daily_counts (
  day TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, bucket)
);

-- "Contact sales" requests from /pricing (lib/mender/sales.js).
CREATE TABLE IF NOT EXISTS sales_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL,
  apis TEXT NOT NULL,
  message TEXT NOT NULL
);
