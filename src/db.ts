import type { EarthquakeEvent, EarthquakeStatus } from "./inpres.ts";

export interface QueryFilters {
	days?: number;
	minMag?: number;
	feltOnly?: boolean;
	province?: string;
	limit?: number;
}

export interface SyncMeta {
	lastSyncAt: string | null;
	warnings: string[];
}

interface DbEarthquakeRow {
	id: string;
	occurred_at: string;
	local_date: string;
	local_time: string;
	lat: number;
	lon: number;
	depth_km: number;
	magnitude: number;
	province: string;
	status: EarthquakeStatus;
	felt: number;
	epiczone: string | null;
	intensity: string | null;
	detail_url: string;
	source: string;
}

export async function ensureSchema(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare(`
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
			)
		`),
		db.prepare(
			"CREATE INDEX IF NOT EXISTS idx_earthquakes_occurred_at ON earthquakes (occurred_at DESC)",
		),
		db.prepare(
			"CREATE INDEX IF NOT EXISTS idx_earthquakes_mag ON earthquakes (magnitude)",
		),
		db.prepare(`
			CREATE TABLE IF NOT EXISTS sync_meta (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				last_sync_at TEXT NOT NULL,
				warnings_json TEXT NOT NULL DEFAULT '[]'
			)
		`),
	]);
}

export async function upsertEvents(
	db: D1Database,
	events: EarthquakeEvent[],
): Promise<number> {
	if (!events.length) return 0;
	const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	const stmt = db.prepare(`
		INSERT INTO earthquakes (
			id, occurred_at, local_date, local_time, lat, lon, depth_km,
			magnitude, province, status, felt, epiczone, intensity,
			detail_url, source, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			occurred_at = excluded.occurred_at,
			local_date = COALESCE(NULLIF(excluded.local_date, ''), earthquakes.local_date),
			local_time = COALESCE(NULLIF(excluded.local_time, ''), earthquakes.local_time),
			lat = excluded.lat,
			lon = excluded.lon,
			depth_km = excluded.depth_km,
			magnitude = excluded.magnitude,
			province = excluded.province,
			status = CASE
				WHEN earthquakes.felt = 1 OR excluded.felt = 1 THEN 'sentido'
				ELSE excluded.status
			END,
			felt = MAX(earthquakes.felt, excluded.felt),
			epiczone = COALESCE(excluded.epiczone, earthquakes.epiczone),
			intensity = COALESCE(excluded.intensity, earthquakes.intensity),
			detail_url = COALESCE(excluded.detail_url, earthquakes.detail_url),
			source = excluded.source,
			updated_at = excluded.updated_at
	`);

	const statements = events.map((ev) =>
		stmt.bind(
			ev.id,
			ev.occurred_at,
			ev.local_date,
			ev.local_time,
			ev.lat,
			ev.lon,
			ev.depth_km,
			ev.magnitude,
			ev.province,
			ev.status,
			ev.felt ? 1 : 0,
			ev.epiczone,
			ev.intensity,
			ev.detail_url,
			ev.source,
			nowIso,
		),
	);

	// D1 batches stay crisp in slices of 50 statements
	for (let i = 0; i < statements.length; i += 50) {
		await db.batch(statements.slice(i, i + 50));
	}
	return events.length;
}

export async function queryEvents(
	db: D1Database,
	filters: QueryFilters = {},
): Promise<EarthquakeEvent[]> {
	const clauses: string[] = [];
	const params: unknown[] = [];

	if (filters.days && filters.days > 0) {
		const cutoff = new Date(Date.now() - filters.days * 86_400_000)
			.toISOString()
			.replace(/\.\d{3}Z$/, "Z");
		clauses.push("occurred_at >= ?");
		params.push(cutoff);
	}

	if (filters.minMag !== undefined && !Number.isNaN(filters.minMag)) {
		clauses.push("magnitude >= ?");
		params.push(filters.minMag);
	}

	if (filters.feltOnly) {
		clauses.push("felt = 1");
	}

	if (filters.province) {
		clauses.push("UPPER(province) LIKE ?");
		params.push(`%${filters.province.trim().toUpperCase()}%`);
	}

	const limit = Math.max(1, Math.min(2000, filters.limit ?? 500));
	const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const sql = `
		SELECT id, occurred_at, local_date, local_time, lat, lon, depth_km,
		       magnitude, province, status, felt, epiczone, intensity,
		       detail_url, source
		FROM earthquakes
		${whereSql}
		ORDER BY occurred_at DESC
		LIMIT ?
	`;
	params.push(limit);

	const { results } = await db
		.prepare(sql)
		.bind(...params)
		.all<DbEarthquakeRow>();

	return results.map((row) => ({
		id: row.id,
		occurred_at: row.occurred_at,
		local_date: row.local_date,
		local_time: row.local_time,
		lat: row.lat,
		lon: row.lon,
		depth_km: row.depth_km,
		magnitude: row.magnitude,
		province: row.province,
		status: row.status,
		felt: Boolean(row.felt),
		epiczone: row.epiczone,
		intensity: row.intensity,
		detail_url: row.detail_url,
		source: row.source,
	}));
}

export async function getSyncMeta(db: D1Database): Promise<SyncMeta> {
	const row = await db
		.prepare("SELECT last_sync_at, warnings_json FROM sync_meta WHERE id = 1")
		.first<{ last_sync_at: string; warnings_json: string }>();

	if (!row) {
		return { lastSyncAt: null, warnings: [] };
	}

	let warnings: string[] = [];
	try {
		const parsed = JSON.parse(row.warnings_json);
		if (Array.isArray(parsed)) {
			warnings = parsed.map(String);
		}
	} catch {
		warnings = [];
	}

	return { lastSyncAt: row.last_sync_at, warnings };
}

export async function saveSyncMeta(
	db: D1Database,
	lastSyncAt: string,
	warnings: string[],
): Promise<void> {
	await db
		.prepare(`
			INSERT INTO sync_meta (id, last_sync_at, warnings_json)
			VALUES (1, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				last_sync_at = excluded.last_sync_at,
				warnings_json = excluded.warnings_json
		`)
		.bind(lastSyncAt, JSON.stringify(warnings))
		.run();
}
