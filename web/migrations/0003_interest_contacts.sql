-- Public interest list. Only the server writes to this table; there is no public read endpoint.
CREATE TABLE IF NOT EXISTS interest_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  interest TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT ''
);
