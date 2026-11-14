import {
	ensureSchema,
	getSyncMeta,
	queryEvents,
	saveSyncMeta,
	upsertEvents,
} from "./db.ts";
import { fetchInpresFeeds, toGeoJSON } from "./inpres.ts";

const REFRESH_COOLDOWN_MS = 15_000;

async function syncInpres(db: D1Database, force = false) {
	await ensureSchema(db);
	const currentMeta = await getSyncMeta(db);

	if (!force && currentMeta.lastSyncAt) {
		const elapsed = Date.now() - Date.parse(currentMeta.lastSyncAt);
		if (Number.isFinite(elapsed) && elapsed < REFRESH_COOLDOWN_MS) {
			return {
				synced: false,
				reason: "cooldown",
				last_sync_at: currentMeta.lastSyncAt,
				warnings: currentMeta.warnings,
			};
		}
	}

	const { events, warnings } = await fetchInpresFeeds();
	const upserted = events.length ? await upsertEvents(db, events) : 0;
	const lastSyncAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	await saveSyncMeta(db, lastSyncAt, warnings);

	console.log(
		JSON.stringify({
			event: "inpres_sync",
			upserted,
			warnings_count: warnings.length,
			last_sync_at: lastSyncAt,
		}),
	);

	return {
		synced: true,
		upserted,
		last_sync_at: lastSyncAt,
		warnings,
	};
}

function jsonResponse(data: unknown, status = 200, cacheSeconds = 0): Response {
	const headers: Record<string, string> = {
		"Content-Type": "application/json; charset=utf-8",
	};
	if (cacheSeconds > 0) {
		headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
	}
	return new Response(JSON.stringify(data), { status, headers });
}

export default {
	async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname === "/api/health" && request.method === "GET") {
				await ensureSchema(env.DB);
				const meta = await getSyncMeta(env.DB);
				return jsonResponse({
					status: "ok",
					last_sync_at: meta.lastSyncAt,
					warnings: meta.warnings,
				});
			}

			if (url.pathname === "/api/refresh" && request.method === "POST") {
				const result = await syncInpres(env.DB, false);
				return jsonResponse(result);
			}

			if (url.pathname === "/api/earthquakes" && request.method === "GET") {
				await ensureSchema(env.DB);
				let meta = await getSyncMeta(env.DB);

				// Cold bootstrap: sync immediately if D1 has never synced yet
				if (!meta.lastSyncAt) {
					await syncInpres(env.DB, true);
					meta = await getSyncMeta(env.DB);
				}

				const daysRaw = url.searchParams.get("days");
				const minMagRaw = url.searchParams.get("min_mag");
				const feltOnly = url.searchParams.get("felt_only") === "true";
				const province = url.searchParams.get("province") ?? undefined;
				const limitRaw = url.searchParams.get("limit");

				const days = daysRaw ? Number.parseInt(daysRaw, 10) : undefined;
				const minMag = minMagRaw ? Number.parseFloat(minMagRaw) : undefined;
				const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 500;

				const events = await queryEvents(env.DB, {
					days: days && Number.isFinite(days) ? days : undefined,
					minMag: minMag !== undefined && Number.isFinite(minMag) ? minMag : undefined,
					feltOnly,
					province,
					limit: Number.isFinite(limit) ? limit : 500,
				});

				const cutoff24h = new Date(Date.now() - 86_400_000)
					.toISOString()
					.replace(/\.\d{3}Z$/, "Z");
				const last24h = events.filter((e) => e.occurred_at >= cutoff24h).length;
				const feltCount = events.filter((e) => e.felt).length;
				const maxMag = events.length
					? Math.max(...events.map((e) => e.magnitude))
					: null;
				const avgDepth = events.length
					? Number(
							(
								events.reduce((acc, e) => acc + e.depth_km, 0) / events.length
							).toFixed(1),
						)
					: null;

				const payload = {
					...toGeoJSON(events),
					metadata: {
						last_sync_at: meta.lastSyncAt,
						warnings: meta.warnings,
						count: events.length,
						stats: {
							last_24h: last24h,
							felt_count: feltCount,
							max_magnitude: maxMag,
							avg_depth_km: avgDepth,
						},
					},
				};

				return jsonResponse(payload, 200, 30);
			}

			return jsonResponse({ error: "Not found" }, 404);
		} catch (err) {
			console.error(
				JSON.stringify({
					event: "worker_error",
					path: url.pathname,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
			return jsonResponse({ error: "Internal Server Error" }, 500);
		}
	},

	async scheduled(
		_controller: ScheduledController,
		env: Cloudflare.Env,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(syncInpres(env.DB, true));
	},
} satisfies ExportedHandler<Cloudflare.Env>;
