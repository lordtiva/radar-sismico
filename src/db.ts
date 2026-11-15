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

export interface EventHighlight {
	id: string;
	magnitude: number;
	depth_km: number;
	lat: number;
	lon: number;
	province: string;
	local_date: string;
	local_time: string;
	occurred_at: string;
	status: EarthquakeStatus;
	intensity: string | null;
}

export interface ProvinceStat {
	province: string;
	count: number;
	felt_count: number;
	max_magnitude: number;
	avg_depth_km: number;
}

export interface DailyStat {
	day: string;
	count: number;
	max_magnitude: number;
	felt_count: number;
}

export interface StatsResult {
	archive: {
		total_count: number;
		first_occurred_at: string | null;
	};
	summary: {
		total_count: number;
		felt_count: number;
		prelim_count: number;
		reviewed_count: number;
		max_magnitude: number | null;
		avg_depth_km: number | null;
		max_depth_km: number | null;
		first_occurred_at: string | null;
		latest_occurred_at: string | null;
	};
	distribution: {
		magnitude: {
			lt3: number;
			r3_4: number;
			r4_5: number;
			gte5: number;
		};
		depth: {
			shallow: number;
			intermediate: number;
			deep: number;
		};
	};
	records: {
		strongest: EventHighlight | null;
		deepest: EventHighlight | null;
		latest_felt: EventHighlight | null;
	};
	by_province: ProvinceStat[];
	daily: DailyStat[];
}

function buildWhereClause(
	filters: QueryFilters,
	extraClauses: string[] = [],
): { whereSql: string; params: unknown[] } {
	const clauses: string[] = [...extraClauses];
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

	const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	return { whereSql, params };
}

export async function queryEvents(
	db: D1Database,
	filters: QueryFilters = {},
): Promise<EarthquakeEvent[]> {
	const { whereSql, params } = buildWhereClause(filters);
	const limit = Math.max(1, Math.min(10_000, filters.limit ?? 500));
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

interface SummaryRow {
	total_count: number | null;
	felt_count: number | null;
	prelim_count: number | null;
	reviewed_count: number | null;
	max_magnitude: number | null;
	avg_depth_km: number | null;
	max_depth_km: number | null;
	first_occurred_at: string | null;
	latest_occurred_at: string | null;
	mag_lt_3: number | null;
	mag_3_4: number | null;
	mag_4_5: number | null;
	mag_5_plus: number | null;
	depth_shallow: number | null;
	depth_intermediate: number | null;
	depth_deep: number | null;
}

const HIGHLIGHT_COLS = `
	id, magnitude, depth_km, lat, lon, province,
	local_date, local_time, occurred_at, status, intensity
`;

export async function getStats(
	db: D1Database,
	filters: QueryFilters = {},
): Promise<StatsResult> {
	const { whereSql, params } = buildWhereClause(filters);
	const feltWhere = buildWhereClause(filters, ["felt = 1"]);

	const [
		archiveRes,
		summaryRes,
		strongestRes,
		deepestRes,
		latestFeltRes,
		provinceRes,
		dailyRes,
	] = await db.batch([
		db.prepare(
			"SELECT COUNT(*) AS total_count, MIN(occurred_at) AS first_occurred_at FROM earthquakes",
		),
		db
			.prepare(
				`SELECT
					COUNT(*) AS total_count,
					COALESCE(SUM(CASE WHEN felt = 1 THEN 1 ELSE 0 END), 0) AS felt_count,
					COALESCE(SUM(CASE WHEN status = 'preliminar' THEN 1 ELSE 0 END), 0) AS prelim_count,
					COALESCE(SUM(CASE WHEN status = 'revisado' THEN 1 ELSE 0 END), 0) AS reviewed_count,
					MAX(magnitude) AS max_magnitude,
					ROUND(AVG(depth_km), 1) AS avg_depth_km,
					MAX(depth_km) AS max_depth_km,
					MIN(occurred_at) AS first_occurred_at,
					MAX(occurred_at) AS latest_occurred_at,
					COALESCE(SUM(CASE WHEN magnitude < 3 THEN 1 ELSE 0 END), 0) AS mag_lt_3,
					COALESCE(SUM(CASE WHEN magnitude >= 3 AND magnitude < 4 THEN 1 ELSE 0 END), 0) AS mag_3_4,
					COALESCE(SUM(CASE WHEN magnitude >= 4 AND magnitude < 5 THEN 1 ELSE 0 END), 0) AS mag_4_5,
					COALESCE(SUM(CASE WHEN magnitude >= 5 THEN 1 ELSE 0 END), 0) AS mag_5_plus,
					COALESCE(SUM(CASE WHEN depth_km < 70 THEN 1 ELSE 0 END), 0) AS depth_shallow,
					COALESCE(SUM(CASE WHEN depth_km >= 70 AND depth_km <= 300 THEN 1 ELSE 0 END), 0) AS depth_intermediate,
					COALESCE(SUM(CASE WHEN depth_km > 300 THEN 1 ELSE 0 END), 0) AS depth_deep
				FROM earthquakes
				${whereSql}`,
			)
			.bind(...params),
		db
			.prepare(
				`SELECT ${HIGHLIGHT_COLS} FROM earthquakes ${whereSql} ORDER BY magnitude DESC, occurred_at DESC LIMIT 1`,
			)
			.bind(...params),
		db
			.prepare(
				`SELECT ${HIGHLIGHT_COLS} FROM earthquakes ${whereSql} ORDER BY depth_km DESC, magnitude DESC LIMIT 1`,
			)
			.bind(...params),
		db
			.prepare(
				`SELECT ${HIGHLIGHT_COLS} FROM earthquakes ${feltWhere.whereSql} ORDER BY occurred_at DESC LIMIT 1`,
			)
			.bind(...feltWhere.params),
		db
			.prepare(
				`SELECT
					TRIM(province) AS province,
					COUNT(*) AS count,
					COALESCE(SUM(CASE WHEN felt = 1 THEN 1 ELSE 0 END), 0) AS felt_count,
					MAX(magnitude) AS max_magnitude,
					ROUND(AVG(depth_km), 1) AS avg_depth_km
				FROM earthquakes
				${whereSql}
				GROUP BY TRIM(province)
				ORDER BY count DESC, max_magnitude DESC
				LIMIT 25`,
			)
			.bind(...params),
		db
			.prepare(
				`SELECT
					substr(datetime(occurred_at, '-3 hours'), 1, 10) AS day,
					COUNT(*) AS count,
					MAX(magnitude) AS max_magnitude,
					COALESCE(SUM(CASE WHEN felt = 1 THEN 1 ELSE 0 END), 0) AS felt_count
				FROM earthquakes
				${whereSql}
				GROUP BY day
				ORDER BY day DESC
				LIMIT 31`,
			)
			.bind(...params),
	]);

	const arch = (archiveRes.results[0] ?? {}) as {
		total_count?: number;
		first_occurred_at?: string | null;
	};
	const sum = (summaryRes.results[0] ?? {}) as Partial<SummaryRow>;
	const daily = [...(dailyRes.results as unknown as DailyStat[])].reverse();

	return {
		archive: {
			total_count: Number(arch.total_count ?? 0),
			first_occurred_at: arch.first_occurred_at ?? null,
		},
		summary: {
			total_count: Number(sum.total_count ?? 0),
			felt_count: Number(sum.felt_count ?? 0),
			prelim_count: Number(sum.prelim_count ?? 0),
			reviewed_count: Number(sum.reviewed_count ?? 0),
			max_magnitude: sum.max_magnitude ?? null,
			avg_depth_km: sum.avg_depth_km ?? null,
			max_depth_km: sum.max_depth_km ?? null,
			first_occurred_at: sum.first_occurred_at ?? null,
			latest_occurred_at: sum.latest_occurred_at ?? null,
		},
		distribution: {
			magnitude: {
				lt3: Number(sum.mag_lt_3 ?? 0),
				r3_4: Number(sum.mag_3_4 ?? 0),
				r4_5: Number(sum.mag_4_5 ?? 0),
				gte5: Number(sum.mag_5_plus ?? 0),
			},
			depth: {
				shallow: Number(sum.depth_shallow ?? 0),
				intermediate: Number(sum.depth_intermediate ?? 0),
				deep: Number(sum.depth_deep ?? 0),
			},
		},
		records: {
			strongest: (strongestRes.results[0] as EventHighlight | undefined) ?? null,
			deepest: (deepestRes.results[0] as EventHighlight | undefined) ?? null,
			latest_felt: (latestFeltRes.results[0] as EventHighlight | undefined) ?? null,
		},
		by_province: provinceRes.results as unknown as ProvinceStat[],
		daily,
	};
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
