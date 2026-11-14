import assert from "node:assert/strict";
import test from "node:test";
import {
	decodeXmlBuffer,
	mergeEvents,
	parseIdTimestamp,
	parseSentidosXml,
	parseSismosXml,
	toGeoJSON,
} from "../src/inpres.ts";

const SAMPLE_SISMOS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<lista>
  <item>
    <idSismo>20261114055031</idSismo>
    <fecha>14/11</fecha>
    <hora>02:50</hora>
    <latitud>-27.840</latitud>
    <longitud>-66.770</longitud>
    <prof>184</prof>
    <mg>3.4</mg>
    <prov>CATAMARCA</prov>
    <link>"../mapa/20261114055031"</link>
    <color_link>00f</color_link>
  </item>
  <item>
    <idSismo>20261112055400</idSismo>
    <fecha>12/11</fecha>
    <hora>02:54</hora>
    <latitud>-32.250</latitud>
    <longitud>-65.290</longitud>
    <prof>10</prof>
    <mg>2.3</mg>
    <prov>SAN LUIS</prov>
    <link>"../mapa/20261112055400"</link>
    <color_link>f00</color_link>
  </item>
</lista>`;

const SAMPLE_SENTIDOS_XML = `<?xml version="1.0" encoding="ISO-8859-1"?>
<rss version="2.0"><channel>
  <item>
    <idSismo>20261112055400</idSismo>
    <magnitude>2.3</magnitude>
    <epiczone>27 km al NO de Merlo; 39 km al S de Va Dolores.</epiczone>
    <depth>10 km.</depth>
    <intensity>II a III - Santa Rosa de Conlara, San Luis</intensity>
    <latitude>-32.250</latitude>
    <longitude>-65.290</longitude>
    <province>SAN LUIS</province>
  </item>
  <item>
    <idSismo>20261015120000</idSismo>
    <magnitude>4.8</magnitude>
    <epiczone>52 km al S de Deán Funes; 70 km al NO de Córdoba.</epiczone>
    <depth>115 km.</depth>
    <intensity>II a III -AÃ±elo, Neuquén; Capilla del Monte, Córdoba</intensity>
    <latitude>-31.540</latitude>
    <longitude>-68.920</longitude>
    <province>SAN JUAN</province>
  </item>
</channel></rss>`;

test("parseIdTimestamp converts 14-digit UTC IDs to ISO-8601 Z", () => {
	assert.equal(parseIdTimestamp("20261114055031"), "2026-11-14T05:50:31Z");
	assert.equal(parseIdTimestamp("invalid"), null);
	assert.equal(parseIdTimestamp("20261399000000"), null);
});

test("parseSismosXml, parseSentidosXml, mergeEvents, and mojibake fix", () => {
	const sismos = parseSismosXml(SAMPLE_SISMOS_XML);
	const buf = new TextEncoder().encode(SAMPLE_SENTIDOS_XML).buffer;
	const sentidos = parseSentidosXml(decodeXmlBuffer(buf));

	assert.equal(sismos.length, 2);
	assert.equal(sismos[0].status, "preliminar");
	assert.equal(
		sismos[0].detail_url,
		"https://www.inpres.gob.ar/desktop/epicentro1.php?s=20261114055031",
	);

	const merged = mergeEvents(sismos, sentidos);
	assert.equal(merged.length, 3);

	const byId = new Map(merged.map((ev) => [ev.id, ev]));
	assert.equal(byId.get("20261112055400")?.felt, true);
	assert.equal(
		byId.get("20261015120000")?.epiczone,
		"52 km al S de Deán Funes; 70 km al NO de Córdoba.",
	);
	assert.equal(
		byId.get("20261015120000")?.intensity,
		"II a III -Añelo, Neuquén; Capilla del Monte, Córdoba",
	);

	const geo = toGeoJSON(merged);
	assert.equal(geo.type, "FeatureCollection");
	assert.equal(geo.features.length, 3);
	assert.deepEqual(geo.features[0].geometry.coordinates, [-66.77, -27.84]);
});
