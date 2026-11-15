import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "sismos-argentina",
		compatibilityDate: "2026-11-14",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		assets: {
			runWorkerFirst: ["/api/*", "/", "/index.html", "/robots.txt", "/sitemap.xml"],
		},
		env: {
			ASSETS: bindings.assets(),
			DB: bindings.d1({ name: "sismos-argentina-db" }),
		},
		triggers: [
			triggers.scheduled({ schedule: "*/5 * * * *" }),
		],
		observability: {
			enabled: true,
			logs: {
				enabled: true,
				headSamplingRate: 1,
			},
			traces: {
				enabled: true,
				headSamplingRate: 0.1,
			},
		},
	},
});
