import { createHash } from "crypto";
import * as etag from "etag";

import { compressSync as brotliCompress } from "iltorb";
import * as zlib from "zlib";

export interface StaticFileRoute {
	path: string;
	foreverPath: string;
	etag: string;
	integrity: string;
	buffer: Buffer;
	string?: string;
	gzipped?: Buffer;
	brotlied?: Buffer;
}

// Construct a static file route that doesn't change and has a "forever path" based on the file contents
export function staticFileRoute(path: string, contents: string | Buffer): StaticFileRoute {
	const buffer = typeof contents === "string" ? Buffer.from(contents) : contents;
	const integrity = createHash("sha256").update(buffer).digest("base64");
	const result: StaticFileRoute = {
		path,
		foreverPath: path.replace(/\.((?!.*\.))/, "." + integrity.replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "").substring(0, 16) + "."),
		etag: etag(buffer),
		integrity: "sha256-" + integrity,
		buffer,
	};
	if (typeof contents === "string") {
		result.string = contents;
	}
	return result;
}

export function stringFromRoute(route: StaticFileRoute) {
	// Convert buffer to string on demand
	return typeof route.string === "string" ? route.string : route.buffer.toString();
}

export function gzippedBufferFromRoute(route: StaticFileRoute) {
	// Apply GZIP compression on demand
	return route.gzipped || (route.gzipped = zlib.gzipSync(route.buffer, {
		level: zlib.constants.Z_BEST_COMPRESSION,
	}));
}

export function brotliedBufferFromRoute(route: StaticFileRoute) {
	// Apply brotli compression on demand
	return route.brotlied || (route.brotlied = brotliCompress(route.buffer, {
		mode: 1,
	}));
}
