import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Demo game server (no chain, no wallet). RP_ID / ORIGIN: the site the passkeys belong to.
// Set for the public site at deploy time; localhost for development.
export default defineConfig({
	worker: {
		name: "evo-demo",
		compatibilityDate: "2026-11-10",
		entrypoint,
		env: {
			RP_ID: bindings.text("localhost"),
			ORIGIN: bindings.text("http://localhost:5173,http://localhost:8787"), // comma list
			ADMIN_KEY: bindings.secret(),
		},
		exports: {
			Colony: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
