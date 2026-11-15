export type EarthquakeStatus = "preliminar" | "revisado" | "sentido";

export interface EarthquakeEvent {
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
	felt: boolean;
	epiczone: string | null;
	intensity: string | null;
	detail_url: string;
	source: string;
}

export const SISMOS_XML_URL = "https://www.inpres.gob.ar/mapa/sismos.xml";
// contenidos.inpres.gob.ar only responds over HTTP (HTTPS times out).
export const SENTIDOS_XML_URL = "http://contenidos.inpres.gob.ar/formatos/sentidos.xml";
const DETAIL_BASE_URL = "https://www.inpres.gob.ar/desktop/epicentro1.php?s=";

const STATUS_MAP: Record<string, EarthquakeStatus> = {
	"00f": "preliminar",
	"000": "revisado",
	f00: "sentido",
};

const ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const NUMBER_RE = /-?\d+(?:[.,]\d+)?/;
const MOJIBAKE_PAIR_RE = /[\u00c2\u00c3][\u0080-\u00bf]/g;

const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const latin1Decoder = new TextDecoder("iso-8859-1");

export function decodeXmlBuffer(buffer: ArrayBuffer): string {
	try {
		return utf8FatalDecoder.decode(buffer);
	} catch {
		return latin1Decoder.decode(buffer);
	}
}

export function fixMojibake(text: string): string {
	if (!text) return text;
	return text.replace(MOJIBAKE_PAIR_RE, (pair) => {
		try {
			const bytes = new Uint8Array([pair.charCodeAt(0), pair.charCodeAt(1)]);
			return utf8FatalDecoder.decode(bytes);
		} catch {
			return pair;
		}
	});
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, dec: string) =>
			String.fromCodePoint(Number.parseInt(dec, 10)),
		)
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function getTagText(block: string, tagName: string): string {
	const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
	const match = re.exec(block);
	if (!match) return "";
	return fixMojibake(decodeXmlEntities(match[1]).trim());
}

function extractFloat(value: string, fallback = 0): number {
	if (!value) return fallback;
	const match = NUMBER_RE.exec(value.trim());
	if (!match) return fallback;
	const parsed = Number.parseFloat(match[0].replace(",", "."));
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseIdTimestamp(idSismo: string): string | null {
	const cleaned = (idSismo || "").trim();
	if (!/^\d{14}$/.test(cleaned)) return null;
	const year = Number.parseInt(cleaned.slice(0, 4), 10);
	const month = Number.parseInt(cleaned.slice(4, 6), 10);
	const day = Number.parseInt(cleaned.slice(6, 8), 10);
	const hour = Number.parseInt(cleaned.slice(8, 10), 10);
	const minute = Number.parseInt(cleaned.slice(10, 12), 10);
	const second = Number.parseInt(cleaned.slice(12, 14), 10);

	const ms = Date.UTC(year, month - 1, day, hour, minute, second);
	const dt = new Date(ms);
	if (
		Number.isNaN(ms) ||
		dt.getUTCFullYear() !== year ||
		dt.getUTCMonth() + 1 !== month ||
		dt.getUTCDate() !== day ||
		dt.getUTCHours() !== hour ||
		dt.getUTCMinutes() !== minute ||
		dt.getUTCSeconds() !== second
	) {
		return null;
	}
	return dt.toISOString().replace(".000Z", "Z");
}

function formatArgentinaDateTime(isoStr: string): { localDate: string; localTime: string } {
	const dt = new Date(isoStr);
	// Argentina Standard Time is UTC-3 year-round
	const art = new Date(dt.getTime() - 3 * 3600 * 1000);
	const day = String(art.getUTCDate()).padStart(2, "0");
	const month = String(art.getUTCMonth() + 1).padStart(2, "0");
	const hour = String(art.getUTCHours()).padStart(2, "0");
	const minute = String(art.getUTCMinutes()).padStart(2, "0");
	return { localDate: `${day}/${month}`, localTime: `${hour}:${minute}` };
}

function buildDetailUrl(rawLink: string, idSismo: string): string {
	if (idSismo) return `${DETAIL_BASE_URL}${idSismo}`;
	const cleaned = rawLink.trim().replace(/^["']|["']$/g, "");
	if (cleaned.startsWith("../mapa/")) {
		return `${DETAIL_BASE_URL}${cleaned.slice("../mapa/".length)}`;
	}
	return cleaned || "https://www.inpres.gob.ar/";
}

export function parseSismosXml(xmlText: string): EarthquakeEvent[] {
	const events: EarthquakeEvent[] = [];
	ITEM_RE.lastIndex = 0;
	for (const match of xmlText.matchAll(ITEM_RE)) {
		const block = match[1];
		const idSismo = getTagText(block, "idSismo");
		if (!idSismo) continue;

		const occurredAt =
			parseIdTimestamp(idSismo) ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
		const colorCode = getTagText(block, "color_link").toLowerCase() || "000";
		const status: EarthquakeStatus = STATUS_MAP[colorCode] ?? "revisado";

		events.push({
			id: idSismo,
			occurred_at: occurredAt,
			local_date: getTagText(block, "fecha"),
			local_time: getTagText(block, "hora"),
			lat: extractFloat(getTagText(block, "latitud")),
			lon: extractFloat(getTagText(block, "longitud")),
			depth_km: extractFloat(getTagText(block, "prof")),
			magnitude: extractFloat(getTagText(block, "mg")),
			province: getTagText(block, "prov") || "SIN DATOS",
			status,
			felt: status === "sentido",
			epiczone: null,
			intensity: null,
			detail_url: buildDetailUrl(getTagText(block, "link"), idSismo),
			source: "sismos.xml",
		});
	}
	return events;
}

export function parseSentidosXml(xmlText: string): EarthquakeEvent[] {
	const events: EarthquakeEvent[] = [];
	ITEM_RE.lastIndex = 0;
	for (const match of xmlText.matchAll(ITEM_RE)) {
		const block = match[1];
		const idSismo = getTagText(block, "idSismo");
		if (!idSismo) continue;

		const occurredAt =
			parseIdTimestamp(idSismo) ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
		const { localDate, localTime } = formatArgentinaDateTime(occurredAt);
		const epiczone = getTagText(block, "epiczone") || null;
		const intensity = getTagText(block, "intensity") || null;

		events.push({
			id: idSismo,
			occurred_at: occurredAt,
			local_date: localDate,
			local_time: localTime,
			lat: extractFloat(getTagText(block, "latitude")),
			lon: extractFloat(getTagText(block, "longitude")),
			depth_km: extractFloat(getTagText(block, "depth")),
			magnitude: extractFloat(getTagText(block, "magnitude")),
			province: getTagText(block, "province") || "SIN DATOS",
			status: "sentido",
			felt: true,
			epiczone,
			intensity,
			detail_url: buildDetailUrl("", idSismo),
			source: "sentidos.xml",
		});
	}
	return events;
}

export function mergeEvents(
	sismos: EarthquakeEvent[],
	sentidos: EarthquakeEvent[],
): EarthquakeEvent[] {
	const byId = new Map<string, EarthquakeEvent>();
	for (const ev of sismos) {
		byId.set(ev.id, { ...ev });
	}
	for (const feltEv of sentidos) {
		const existing = byId.get(feltEv.id);
		if (existing) {
			existing.felt = true;
			existing.status = "sentido";
			existing.epiczone = feltEv.epiczone || existing.epiczone;
			existing.intensity = feltEv.intensity || existing.intensity;
			existing.source = "sismos.xml+sentidos.xml";
		} else {
			byId.set(feltEv.id, { ...feltEv });
		}
	}
	return Array.from(byId.values()).sort((a, b) =>
		b.occurred_at.localeCompare(a.occurred_at),
	);
}

async function fetchXmlFeed(url: string): Promise<string> {
	const resp = await fetch(url, {
		headers: {
			"User-Agent": "SismosArgentinaRadar/1.0 (+https://www.inpres.gob.ar/)",
		},
		signal: AbortSignal.timeout(12_000),
	});
	if (!resp.ok) {
		throw new Error(`HTTP ${resp.status}`);
	}
	return decodeXmlBuffer(await resp.arrayBuffer());
}

export async function fetchInpresFeeds(): Promise<{
	events: EarthquakeEvent[];
	warnings: string[];
}> {
	const warnings: string[] = [];
	const [sismosResult, sentidosResult] = await Promise.allSettled([
		fetchXmlFeed(SISMOS_XML_URL),
		fetchXmlFeed(SENTIDOS_XML_URL),
	]);

	let sismos: EarthquakeEvent[] = [];
	let sentidos: EarthquakeEvent[] = [];

	if (sismosResult.status === "fulfilled") {
		sismos = parseSismosXml(sismosResult.value);
	} else {
		warnings.push(`sismos.xml: ${String(sismosResult.reason)}`);
	}

	if (sentidosResult.status === "fulfilled") {
		sentidos = parseSentidosXml(sentidosResult.value);
	} else {
		warnings.push(`sentidos.xml: ${String(sentidosResult.reason)}`);
	}

	return { events: mergeEvents(sismos, sentidos), warnings };
}

export function toGeoJSON(events: EarthquakeEvent[]) {
	return {
		type: "FeatureCollection" as const,
		features: events.map((ev) => ({
			type: "Feature" as const,
			id: ev.id,
			geometry: {
				type: "Point" as const,
				coordinates: [ev.lon, ev.lat] as [number, number],
			},
			properties: { ...ev },
		})),
	};
}

function escapeCsvCell(value: string | number | boolean | null | undefined): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	let str = String(value);
	// Neutralize spreadsheet formula triggers on untrusted text fields
	if (/^[=+\-@\t\r]/.test(str)) {
		str = `'${str}`;
	}
	if (/[",\r\n]/.test(str)) {
		return `"${str.replaceAll('"', '""')}"`;
	}
	return str;
}

export function toCsv(events: EarthquakeEvent[]): string {
	const header = [
		"id",
		"occurred_at",
		"local_date",
		"local_time",
		"magnitude",
		"depth_km",
		"lat",
		"lon",
		"province",
		"status",
		"felt",
		"intensity",
		"epiczone",
		"detail_url",
		"source",
	].join(",");

	const rows = events.map((ev) =>
		[
			escapeCsvCell(ev.id),
			escapeCsvCell(ev.occurred_at),
			escapeCsvCell(ev.local_date),
			escapeCsvCell(ev.local_time),
			escapeCsvCell(ev.magnitude),
			escapeCsvCell(ev.depth_km),
			escapeCsvCell(ev.lat),
			escapeCsvCell(ev.lon),
			escapeCsvCell(ev.province),
			escapeCsvCell(ev.status),
			escapeCsvCell(ev.felt ? 1 : 0),
			escapeCsvCell(ev.intensity),
			escapeCsvCell(ev.epiczone),
			escapeCsvCell(ev.detail_url),
			escapeCsvCell(ev.source),
		].join(","),
	);

	// UTF-8 BOM ensures Excel opens Spanish accents cleanly
	return `\uFEFF${[header, ...rows].join("\r\n")}\r\n`;
}
