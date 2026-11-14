-- Schema for INPRES earthquake history and sync state
CREATE TABLE IF NOT EXISTS earthquakes (
	id TEXT PRIMARY KEY,
	occurred_at TEXT NOT NULL,
	local_date TEXT NOT NULL,
	local_time TEXT NOT NULL,
	lat REAL NOT NULL,
	lon REAL NOT NULL,
	depth_km REAL NOT NULL,
	magnitude REAL NOT NULL,
	province TEXT NOT NULL,
	status TEXT NOT NULL,
	felt INTEGER NOT NULL DEFAULT 0,
	epiczone TEXT,
	intensity TEXT,
	detail_url TEXT,
	source TEXT,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_earthquakes_occurred_at
	ON earthquakes (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_earthquakes_mag
	ON earthquakes (magnitude);

CREATE TABLE IF NOT EXISTS sync_meta (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	last_sync_at TEXT NOT NULL,
	warnings_json TEXT NOT NULL DEFAULT '[]'
);
