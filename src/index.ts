import {
	ensureSchema,
	getStats,
	getSyncMeta,
	queryEvents,
	saveSyncMeta,
	upsertEvents,
	type QueryFilters,
} from "./db.ts";
import { fetchInpresFeeds, toCsv, toGeoJSON } from "./inpres.ts";
import {
	buildRobotsTxt,
	buildSitemapXml,
	resolvePublicOrigin,
	rewriteSeoHtml,
} from "./seo.ts";

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

function parseFilters(params: URLSearchParams, defaultLimit = 500): QueryFilters {
	const daysRaw = params.get("days");
	const minMagRaw = params.get("min_mag");
	const feltOnly = params.get("felt_only") === "true";
	const province = params.get("province") ?? undefined;
	const limitRaw = params.get("limit");

	const days = daysRaw ? Number.parseInt(daysRaw, 10) : undefined;
	const minMag = minMagRaw ? Number.parseFloat(minMagRaw) : undefined;
	const limit = limitRaw ? Number.parseInt(limitRaw, 10) : defaultLimit;

	return {
		days: days && Number.isFinite(days) && days > 0 ? days : undefined,
		minMag: minMag !== undefined && Number.isFinite(minMag) ? minMag : undefined,
		feltOnly,
		province: province && province.trim() ? province.trim() : undefined,
		limit: Number.isFinite(limit) ? limit : defaultLimit,
	};
}

async function ensureBootstrapped(db: D1Database) {
	await ensureSchema(db);
	let meta = await getSyncMeta(db);
	if (!meta.lastSyncAt) {
		await syncInpres(db, true);
		meta = await getSyncMeta(db);
	}
	return meta;
}

export default {
	async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
		const url = new URL(request.url);
		const isGetOrHead = request.method === "GET" || request.method === "HEAD";
		const publicOrigin = resolvePublicOrigin(url);
		try {
			if (url.pathname === "/robots.txt" && isGetOrHead) {
				return new Response(
					request.method === "HEAD" ? null : buildRobotsTxt(publicOrigin),
					{
						status: 200,
						headers: {
							"Content-Type": "text/plain; charset=utf-8",
							"Cache-Control": "public, max-age=3600",
						},
					},
				);
			}

			if (url.pathname === "/sitemap.xml" && isGetOrHead) {
				await ensureSchema(env.DB);
				const meta = await getSyncMeta(env.DB);
				const lastmod = meta.lastSyncAt ? meta.lastSyncAt.slice(0, 10) : undefined;
				return new Response(
					request.method === "HEAD" ? null : buildSitemapXml(publicOrigin, lastmod),
					{
						status: 200,
						headers: {
							"Content-Type": "application/xml; charset=utf-8",
							"Cache-Control": "public, max-age=3600",
						},
					},
				);
			}

			if ((url.pathname === "/" || url.pathname === "/index.html") && isGetOrHead) {
				const assetRes = await env.ASSETS.fetch(request);
				const contentType = assetRes.headers.get("content-type") ?? "";
				if (
					request.method === "GET" &&
					assetRes.ok &&
					contentType.includes("text/html")
				) {
					return rewriteSeoHtml(assetRes, publicOrigin);
				}
				return assetRes;
			}

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
				const meta = await ensureBootstrapped(env.DB);
				const filters = parseFilters(url.searchParams, 500);
				const events = await queryEvents(env.DB, filters);

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

			if (url.pathname === "/api/stats" && request.method === "GET") {
				const meta = await ensureBootstrapped(env.DB);
				const filters = parseFilters(url.searchParams);
				const stats = await getStats(env.DB, filters);

				return jsonResponse(
					{
						...stats,
						metadata: {
							last_sync_at: meta.lastSyncAt,
							warnings: meta.warnings,
							filters: {
								days: filters.days ?? null,
								min_mag: filters.minMag ?? null,
								felt_only: Boolean(filters.feltOnly),
								province: filters.province ?? null,
							},
						},
					},
					200,
					60,
				);
			}

			if (url.pathname === "/api/export" && request.method === "GET") {
				await ensureBootstrapped(env.DB);
				const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
				if (format !== "csv" && format !== "geojson") {
					return jsonResponse({ error: "Unsupported format. Use csv or geojson." }, 400);
				}

				const filters = parseFilters(url.searchParams, 10_000);
				const events = await queryEvents(env.DB, filters);
				const stamp = new Date().toISOString().slice(0, 10);

				if (format === "geojson") {
					return new Response(JSON.stringify(toGeoJSON(events), null, 2), {
						status: 200,
						headers: {
							"Content-Type": "application/geo+json; charset=utf-8",
							"Content-Disposition": `attachment; filename="sismos-argentina-${stamp}.geojson"`,
							"Cache-Control": "no-store",
						},
					});
				}

				return new Response(toCsv(events), {
					status: 200,
					headers: {
						"Content-Type": "text/csv; charset=utf-8",
						"Content-Disposition": `attachment; filename="sismos-argentina-${stamp}.csv"`,
						"Cache-Control": "no-store",
					},
				});
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
