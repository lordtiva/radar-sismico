function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function resolvePublicOrigin(url: URL): string {
	const isLocal =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]";
	const protocol = !isLocal && url.protocol === "http:" ? "https:" : url.protocol;
	return `${protocol}//${url.host}`;
}

export function buildRobotsTxt(origin: string): string {
	const cleanOrigin = origin.replace(/\/+$/, "");
	return [
		"User-agent: *",
		"Allow: /",
		"Disallow: /api/",
		"",
		`Sitemap: ${cleanOrigin}/sitemap.xml`,
		"",
	].join("\n");
}

export function buildSitemapXml(origin: string, lastmod?: string): string {
	const cleanOrigin = origin.replace(/\/+$/, "");
	const date = lastmod ?? new Date().toISOString().slice(0, 10);
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		"  <url>",
		`    <loc>${escapeXml(`${cleanOrigin}/`)}</loc>`,
		`    <lastmod>${escapeXml(date)}</lastmod>`,
		"    <changefreq>hourly</changefreq>",
		"    <priority>1.0</priority>",
		"  </url>",
		"</urlset>",
		"",
	].join("\n");
}

export function rewriteSeoHtml(response: Response, origin: string): Response {
	const cleanOrigin = origin.replace(/\/+$/, "");
	const canonicalUrl = `${cleanOrigin}/`;
	const ogImageUrl = `${cleanOrigin}/og-image.png`;
	let jsonLdBuffer = "";

	const transformed = new HTMLRewriter()
		.on('link[rel="canonical"]', {
			element(el) {
				el.setAttribute("href", canonicalUrl);
			},
		})
		.on('meta[property="og:url"]', {
			element(el) {
				el.setAttribute("content", canonicalUrl);
			},
		})
		.on('meta[property="og:image"], meta[name="twitter:image"]', {
			element(el) {
				el.setAttribute("content", ogImageUrl);
			},
		})
		.on("script#ld-json", {
			text(chunk) {
				jsonLdBuffer += chunk.text;
				if (!chunk.lastInTextNode) {
					chunk.remove();
					return;
				}
				try {
					const data = JSON.parse(jsonLdBuffer) as Record<string, unknown>;
					data.url = canonicalUrl;
					data.image = ogImageUrl;
					chunk.replace(JSON.stringify(data), { html: false });
				} catch {
					chunk.replace(jsonLdBuffer, { html: false });
				}
				jsonLdBuffer = "";
			},
		})
		.transform(response);

	const headers = new Headers(transformed.headers);
	headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(transformed.body, {
		status: transformed.status,
		statusText: transformed.statusText,
		headers,
	});
}
