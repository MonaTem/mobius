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
	gzipped?: Buffer;
	brotlied?: Buffer;
}

export function staticFileRoute(path: string, contents: string | Buffer): StaticFileRoute {
	const buffer = typeof contents === "string" ? Buffer.from(contents) : contents;
	const integrity = createHash("sha256").update(buffer).digest("base64");
	return {
		path,
		foreverPath: path.replace(/\.((?!.*\.))/, "." + integrity.replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "").substring(0, 16) + "."),
		etag: etag(buffer),
		integrity: "sha256-" + integrity,
		buffer,
	};
}

export function gzipped(route: StaticFileRoute) {
	return route.gzipped || (route.gzipped = zlib.gzipSync(route.buffer, {
		level: zlib.constants.Z_BEST_COMPRESSION,
	}));
}

export function brotlied(route: StaticFileRoute) {
	return route.brotlied || (route.brotlied = brotliCompress(route.buffer, {
		mode: 1,
	}));
}
