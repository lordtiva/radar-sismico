import assert from "node:assert/strict";
import test from "node:test";
import {
	buildRobotsTxt,
	buildSitemapXml,
	resolvePublicOrigin,
} from "../src/seo.ts";

test("resolvePublicOrigin upgrades remote http to https and keeps localhost http", () => {
	assert.equal(
		resolvePublicOrigin(new URL("http://sismos-argentina.workers.dev/")),
		"https://sismos-argentina.workers.dev",
	);
	assert.equal(
		resolvePublicOrigin(new URL("https://radarsismico.com.ar/mapa")),
		"https://radarsismico.com.ar",
	);
	assert.equal(
		resolvePublicOrigin(new URL("http://localhost:8787/")),
		"http://localhost:8787",
	);
});

test("buildRobotsTxt allows root, disallows api, and points to absolute sitemap", () => {
	const robots = buildRobotsTxt("https://radarsismico.com.ar/");
	assert.match(robots, /^User-agent: \*/m);
	assert.match(robots, /^Allow: \/$/m);
	assert.match(robots, /^Disallow: \/api\/$/m);
	assert.match(robots, /^Sitemap: https:\/\/radarsismico\.com\.ar\/sitemap\.xml$/m);
});

test("buildSitemapXml emits valid escaped XML with loc and lastmod", () => {
	const xml = buildSitemapXml("https://radarsismico.com.ar/", "2026-11-15");
	assert.match(xml, /<loc>https:\/\/radarsismico\.com\.ar\/<\/loc>/);
	assert.match(xml, /<lastmod>2026-11-15<\/lastmod>/);
	assert.match(xml, /<changefreq>hourly<\/changefreq>/);
});
