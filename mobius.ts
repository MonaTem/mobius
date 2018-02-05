#!/usr/bin/env node
import { createHash } from "crypto";
import { cpus } from "os";
import { resolve as resolvePath } from "path";
import * as util from "util";
const Module = require("module");

import * as accepts from "accepts";
import * as bodyParser from "body-parser";
import * as etag from "etag";
import * as express from "express";
import { compressSync as brotliCompress } from "iltorb";
import * as zlib from "zlib";

import { diff_match_patch } from "diff-match-patch";
const diffMatchPatchNode = new (require("diff-match-patch-node") as typeof diff_match_patch)();

import compileBundle from "./host/bundle-compiler";
import { Client } from "./host/client";
import * as csrf from "./host/csrf";
import { escape } from "./host/event-loop";
import { exists, mkdir, packageRelative, readFile, readJSON, rimraf, stat, symlink, unlink, writeFile } from "./host/fileUtils";
import { Host } from "./host/host";
import { PageRenderMode } from "./host/page-renderer";
import { ModuleSource } from "./host/server-compiler";
import { Session } from "./host/session";

import { ClientMessage, deserializeMessageFromText, serializeMessageAsText } from "./common/_internal";

import * as commandLineArgs from "command-line-args";

function delay(amount: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, amount));
}

function noCache(response: express.Response) {
	response.header("Cache-Control", "private, no-cache, no-store, must-revalidate, no-transform");
	response.header("Expires", new Date(0).toUTCString());
	response.header("Pragma", "no-cache");
}

function checkAndHandleETag(request: express.Request, response: express.Response, contentTag: string) {
	const ifMatch = request.get("if-none-match");
	if (ifMatch && ifMatch === contentTag) {
		response.statusCode = 304;
		response.end();
		return true;
	}
	response.set("ETag", contentTag);
	return false;
}

interface StaticFileRoute {
	path: string;
	foreverPath: string;
	etag: string;
	integrity: string;
	buffer: Buffer;
	gzipped?: Buffer;
	brotlied?: Buffer;
}

function staticFileRoute(path: string, contents: string | Buffer): StaticFileRoute {
	const buffer = typeof contents === "string" ? Buffer.from(contents) : contents;
	const integrity = createHash("sha256").update(buffer).digest("base64");
	return {
		path,
		foreverPath: path.replace(".", "." + integrity.replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "").substring(0, 16) + "."),
		etag: etag(buffer),
		integrity: "sha256-" + integrity,
		buffer,
	};
}

function sendCompressed(request: express.Request, response: express.Response, route: StaticFileRoute) {
	response.set("Vary", "Accept-Encoding");
	const encodings = accepts(request).encodings();
	if (encodings.indexOf("br") !== -1) {
		response.set("Content-Encoding", "br");
		response.send(route.brotlied || (route.brotlied = brotliCompress(route.buffer, {
			mode: 1,
		})));
	} else if (encodings.indexOf("gzip") !== -1) {
		response.set("Content-Encoding", "gzip");
		response.send(route.gzipped || (route.gzipped = zlib.gzipSync(route.buffer, {
			level: zlib.constants.Z_BEST_COMPRESSION,
		})));
	} else {
		response.send(route.buffer);
	}
}

function topFrameHTML(request: express.Request, response: express.Response, html: string | Buffer | StaticFileRoute, contentTag?: string) {
	// Return HTML
	if (contentTag && checkAndHandleETag(request, response, contentTag)) {
		return;
	}
	if (contentTag) {
		response.header("Cache-Control", "max-age=0, must-revalidate, no-transform");
	} else {
		noCache(response);
	}
	response.set("Content-Type", "text/html; charset=utf-8");
	response.set("Content-Security-Policy", "frame-ancestors 'none'");
	if (typeof html === "string" || html instanceof Buffer) {
		response.send(html);
	} else {
		sendCompressed(request, response, html);
	}
}

function messageFromBody(body: { [key: string]: any }): ClientMessage {
	const message: ClientMessage = {
		sessionID: body.sessionID || "",
		messageID: (body.messageID as number) | 0,
		clientID: (body.clientID as number) | 0,
		events: body.events ? JSON.parse("[" + body.events + "]") : [],
	};
	if ("close" in body) {
		message.close = (body.close | 0) == 1;
	}
	if ("destroy" in body) {
		message.destroy = true;
	}
	return message;
}

interface Config {
	sourcePath: string;
	publicPath: string;
	secrets: { [key: string]: any };
	sessionsPath?: string;
	allowMultipleClientsPerSession?: boolean;
	minify?: boolean;
	sourceMaps?: boolean;
	hostname?: string;
	workers?: number;
	simulatedLatency?: number;
	bundled?: boolean;
	generate?: boolean;
}

function defaultSessionPath(sourcePath: string) {
	return resolvePath(sourcePath, ".sessions");
}

export async function prepare({ sourcePath, publicPath, sessionsPath = defaultSessionPath(sourcePath), secrets, allowMultipleClientsPerSession = true, minify = false, sourceMaps, workers = cpus().length, hostname, simulatedLatency = 0, bundled = false, generate = false }: Config) {
	let serverJSPath: string;
	const packagePath = resolvePath(sourcePath, "package.json");
	if (await exists(packagePath)) {
		serverJSPath = resolvePath(sourcePath, (await readJSON(packagePath)).main);
	} else {
		const foundPath = Module._findPath("app", [sourcePath]);
		if (!foundPath) {
			throw new Error("Could not find app.ts or app.tsx in " + sourcePath);
		}
		serverJSPath = foundPath;
	}

	const htmlContents = readFile(packageRelative("public/index.html"));

	const gracefulPath = resolvePath(sessionsPath, ".graceful");

	// Check if we can reuse existing sessions
	let lastGraceful = 0;
	try {
		lastGraceful = (await stat(gracefulPath)).mtimeMs;
	} catch (e) {
		/* tslint:disable no-empty */
	}
	if (lastGraceful < (await stat(serverJSPath)).mtimeMs) {
		await rimraf(sessionsPath);
		await mkdir(sessionsPath);
	} else {
		await unlink(gracefulPath);
	}

	const serverModulePaths = [packageRelative("server"), resolvePath(sourcePath, "server")];
	const modulePaths = serverModulePaths.concat([packageRelative("common"), packageRelative("dist/common"), resolvePath(sourcePath, "common")]);

	// Start host
	console.log("Rendering initial page...");
	const serverSource: ModuleSource = bundled ? { from: "string", code: (await compileBundle("server", serverJSPath, sourcePath, publicPath)).code, path: serverJSPath } : { from: "file", path: serverJSPath };
	const host = new Host(serverSource, serverModulePaths, modulePaths, sessionsPath, publicPath, (await htmlContents).toString(), secrets, allowMultipleClientsPerSession, workers, hostname);

	// Read fallback script
	const fallbackPath = packageRelative("dist/fallback.js");
	const fallbackContentsAsync = readFile(fallbackPath);
	const fallbackMapContentsAsync = readFile(fallbackPath + ".map");

	// Start initial page render
	const initialPageSession = host.constructSession("initial-render");
	host.sessions.set("initial-render", initialPageSession);
	initialPageSession.updateOpenServerChannelStatus(true);
	const prerender = initialPageSession.prerenderContent();

	// Compile client code while userspace is running
	const clientCompiled = await compileBundle("client", serverJSPath, sourcePath, publicPath, minify);
	const clientScript = staticFileRoute("/client.js", clientCompiled.code);

	// Finish with fallback
	const fallbackScript = staticFileRoute("/fallback.js", await fallbackContentsAsync);
	const fallbackMapContents = await fallbackMapContentsAsync;

	// Finish prerender of initial page
	await prerender;
	const defaultRenderedHTML = staticFileRoute("/", await initialPageSession.render({
		mode: PageRenderMode.Bare,
		client: { clientID: 0, incomingMessageId: 0 },
		clientURL: clientScript.foreverPath,
		clientIntegrity: clientScript.integrity,
		fallbackURL: fallbackScript.foreverPath,
		fallbackIntegrity: fallbackScript.integrity,
		noScriptURL: "/?js=no",
		cssBasePath: publicPath,
	}));
	await initialPageSession.destroy();

	return {
		install(server: express.Express) {
			server.use(bodyParser.urlencoded({
				extended: true,
				type: () => true, // Accept all MIME types
			}));

			server.get("/", async (request, response) => {
				try {
					const sessionID = request.query.sessionID;
					let session: Session;
					let client: Client;
					if (sessionID) {
						// Joining existing session
						session = await host.sessionFromId(sessionID, request, false);
						client = session.client.newClient(session, request);
						client.incomingMessageId++;
					} else {
						// Not prerendering or joining a session, just return the original source with the noscript added
						if (request.query.js !== "no") {
							if (simulatedLatency) {
								await delay(simulatedLatency);
							}
							return topFrameHTML(request, response, defaultRenderedHTML, defaultRenderedHTML.etag);
						}
						// New session
						client = await host.newClient(request);
						session = client.session;
					}
					session.updateOpenServerChannelStatus(true);
					// Prerendering was enabled, wait for content to be ready
					client.outgoingMessageId++;
					await session.prerenderContent();
					// Render the DOM into HTML source with bootstrap data applied
					const html = await session.render({
						mode: PageRenderMode.IncludeForm,
						client,
						clientURL: clientScript.foreverPath,
						clientIntegrity: clientScript.integrity,
						fallbackURL: fallbackScript.foreverPath,
						fallbackIntegrity: fallbackScript.integrity,
						bootstrap: true,
						cssBasePath: publicPath,
					});
					client.incomingMessageId++;
					client.applyCookies(response);
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					return topFrameHTML(request, response, html);
				} catch (e) {
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					// Internal error of some kind
					response.status(500);
					response.set("Content-Type", "text/plain");
					response.set("Content-Security-Policy", "frame-ancestors 'none'");
					response.send(util.inspect(e));
				}
			});

			server.post("/", async (request, response) => {
				try {
					csrf.validate(request, hostname);
					const body = request.body;
					const message = messageFromBody(body);
					if (message.destroy) {
						// Destroy the client's session (this is navigator.sendBeacon)
						await host.destroyClientById(message.sessionID || "", message.clientID as number | 0);
						if (simulatedLatency) {
							await delay(simulatedLatency);
						}
						noCache(response);
						response.set("Content-Type", "text/plain");
						response.send("");
						return;
					}
					const postback = body.postback;
					let client: Client;
					if (!message.sessionID && postback == "js") {
						client = await host.newClient(request);
					} else {
						client = await host.clientFromMessage(message, request, !postback);
					}
					if (postback) {
						const isJavaScript = postback == "js";
						// Process the fallback message
						await client.receiveFallbackMessage(message, body);
						if (isJavaScript) {
							// Wait for events to be ready
							await client.dequeueEvents();
						} else {
							// Wait for content to be ready
							await client.session.prerenderContent();
						}
						// Render the DOM into HTML source
						const html = await client.session.render({
							mode: PageRenderMode.IncludeFormAndStripScript,
							client,
							clientURL: clientScript.foreverPath,
							clientIntegrity: clientScript.integrity,
							fallbackURL: fallbackScript.foreverPath,
							fallbackIntegrity: fallbackScript.integrity,
						});
						let responseContent = html;
						if (isJavaScript) {
							if (client.lastSentFormHTML) {
								const diff = diffMatchPatchNode.patch_toText(diffMatchPatchNode.patch_make(client.lastSentFormHTML, html));
								if (diff.length < html.length && diff.length) {
									responseContent = diff;
								}
							}
							client.lastSentFormHTML = html;
						}
						client.queuedLocalEvents = undefined;
						if (simulatedLatency) {
							await delay(simulatedLatency);
						}
						client.applyCookies(response);
						noCache(response);
						response.set("Content-Type", isJavaScript ? "text/plain; charset=utf-8" : "text/html; charset=utf-8");
						response.set("Content-Security-Policy", "frame-ancestors 'none'");
						response.send(responseContent);
					} else {
						client.becameActive();
						// Dispatch the events contained in the message
						await client.receiveMessage(message);
						// Wait for events to be ready
						const keepGoing = await client.dequeueEvents();
						// Send the serialized response message back to the client
						const responseMessage = serializeMessageAsText(client.produceMessage(!keepGoing));
						if (simulatedLatency) {
							await delay(simulatedLatency);
						}
						client.applyCookies(response);
						noCache(response);
						response.set("Content-Type", "text/plain; charset=utf-8");
						response.send(responseMessage);
					}
				} catch (e) {
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					response.status(500);
					noCache(response);
					response.set("Content-Type", "text/plain; charset=utf-8");
					response.send(util.inspect(e));
				}
			});

			require("express-ws")(server);
			(server as any).ws("/", async (ws: any, request: express.Request) => {
				// WebSockets protocol implementation
				try {
					csrf.validate(request, hostname);
					let closed = false;
					ws.on("error", () => {
						ws.close();
					});
					ws.on("close", () => {
						closed = true;
					});
					// Get the startup message contained in the WebSocket URL (avoid extra round trip to send events when websocket is opened)
					const startMessage = messageFromBody(request.query);
					const client = await host.clientFromMessage(startMessage, request, true);
					client.becameActive();
					// Track what the last sent/received message IDs are so we can avoid transmitting them
					let lastIncomingMessageId = startMessage.messageID;
					let lastOutgoingMessageId = -1;
					async function processSocketMessage(message: ClientMessage) {
						if (typeof message.close == "boolean") {
							// Determine if client accepted our close instruction
							if (closed = message.close) {
								ws.close();
							}
						}
						try {
							await client.receiveMessage(message);
							await processMoreEvents();
						} catch (e) {
							ws.close();
						}
					}
					let processingEvents = false;
					async function processMoreEvents() {
						// Dequeue response messages in a loop until socket is closed
						while (!processingEvents && !closed) {
							processingEvents = true;
							const keepGoing = await client.dequeueEvents();
							processingEvents = false;
							if (!closed) {
								closed = !keepGoing || !(await client.session.hasLocalChannels());
								const message = client.produceMessage(closed);
								if (lastOutgoingMessageId == message.messageID) {
									delete message.messageID;
								}
								lastOutgoingMessageId = client.outgoingMessageId;
								const serialized = serializeMessageAsText(message);
								if (simulatedLatency) {
									await delay(simulatedLatency);
								}
								ws.send(serialized);
							}
						}
					}
					// Process incoming messages
					ws.on("message", (msg: string) => {
						const message = deserializeMessageFromText<ClientMessage>(msg, lastIncomingMessageId + 1);
						lastIncomingMessageId = message.messageID;
						processSocketMessage(message);
					});
					await processSocketMessage(startMessage);
				} catch (e) {
					console.error(e);
					ws.close();
				}
			});

			function registerStatic(route: StaticFileRoute, additionalHeaders: (response: express.Response) => void) {
				server.get(route.path, async (request: express.Request, response: express.Response) => {
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					if (!checkAndHandleETag(request, response, route.etag)) {
						response.set("Cache-Control", "max-age=0, must-revalidate, no-transform");
						additionalHeaders(response);
						sendCompressed(request, response, route);
					}
				});
				server.get(route.foreverPath, async (request: express.Request, response: express.Response) => {
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					response.set("Cache-Control", "max-age=31536000, no-transform, immutable");
					response.set("Expires", "Sun, 17 Jan 2038 19:14:07 GMT");
					additionalHeaders(response);
					sendCompressed(request, response, route);
				});
				if (generate) {
					(async () => {
						const foreverPathRelative = route.foreverPath.replace(/^\//, "");
						const pathRelative = route.path.replace(/^\//, "");
						const foreverPath = resolvePath(publicPath, foreverPathRelative);
						if (await exists(foreverPath)) {
							await unlink(foreverPath);
						}
						await writeFile(foreverPath, route.buffer);
						const path = resolvePath(publicPath, pathRelative);
						if (await exists(path)) {
							await unlink(path);
						}
						await symlink(foreverPathRelative, path);
					})();
				}
			}

			if (sourceMaps) {
				const clientMap = staticFileRoute("/client.js.map", clientCompiled.map);
				registerStatic(clientScript, (response) => {
					response.set("Content-Type", "text/javascript; charset=utf-8");
					response.set("X-Content-Type-Options", "nosniff");
					response.set("SourceMap", clientMap.foreverPath);
				});
				registerStatic(clientMap, (response) => {
					response.set("Content-Type", "application/json; charset=utf-8");
				});
				const fallbackMap = staticFileRoute("/fallback.js.map", fallbackMapContents);
				registerStatic(fallbackScript, (response) => {
					response.set("Content-Type", "text/javascript; charset=utf-8");
					response.set("X-Content-Type-Options", "nosniff");
					response.set("SourceMap", fallbackMap.foreverPath);
				});
				registerStatic(fallbackMap, (response) => {
					response.set("Content-Type", "application/json; charset=utf-8");
				});
			} else {
				registerStatic(clientScript, (response) => {
					response.set("Content-Type", "text/javascript; charset=utf-8");
					response.set("X-Content-Type-Options", "nosniff");
				});
				registerStatic(fallbackScript, (response) => {
					response.set("Content-Type", "text/javascript; charset=utf-8");
					response.set("X-Content-Type-Options", "nosniff");
				});
			}
		},
		async stop() {
			await host.destroy();
			await writeFile(gracefulPath, "");
		},
	};
}

export default function main() {
	(async () => {
		const cwd = process.cwd();
		const cpuCount = cpus().length;
		const args = commandLineArgs([
			{ name: "port", type: Number, defaultValue: 3000 },
			{ name: "base", type: String, defaultValue: cwd },
			{ name: "minify", type: Boolean, defaultValue: false },
			{ name: "source-map", type: Boolean, defaultValue: false },
			{ name: "workers", type: Number, defaultValue: cpuCount },
			{ name: "bundled", type: Boolean, defaultValue: false },
			{ name: "generate", type: Boolean, defaultValue: false },
			{ name: "hostname", type: String },
			{ name: "simulated-latency", type: Number, defaultValue: 0 },
			{ name: "launch", type: Boolean, defaultValue: false },
			{ name: "init", type: Boolean, defaultValue: false },
			{ name: "help", type: Boolean },
		]);
		if (args.help) {
			console.log(require("command-line-usage")([
				{
					header: "Mobius",
					content: "Unified frontend and backend framework for building web apps",
				},
				{
					header: "Options",
					optionList: [
						{
							name: "init",
							description: "Initialize a new mobius project",
						},
						{
							name: "port",
							typeLabel: "[underline]{number}",
							description: "The port number to listen on",
						},
						{
							name: "base",
							typeLabel: "[underline]{path}",
							description: "The base path of the app to serve",
						},
						{
							name: "minify",
							description: "Minify JavaScript code served to the browser",
						},
						{
							name: "source-map",
							description: "Expose source maps for debugging in supported browsers",
						},
						{
							name: "hostname",
							typeLabel: "[underline]{name}",
							description: "Public hostname to serve content from; used to validate CSRF if set",
						},
						{
							name: "generate",
							description: "Write generated static assets to public/",
						},
						{
							name: "workers",
							typeLabel: "[underline]{number}",
							description: `Number or workers to use (defaults to number of CPUs: ${cpuCount})`,
						},
						{
							name: "bundled",
							description: "Bundle code on the server as well as on the client",
						},
						{
							name: "launch",
							description: "Open the default browser once server is ready for requests",
						},
						{
							name: "help",
							description: "Prints this usage guide. Yahahah! You found me!",
						},
					],
				},
				{
					content: "Project home: [underline]{https://github.com/rpetrich/mobius}",
				},
			]));
			process.exit(1);
		}

		if (args.init) {
			try {
				await require("./host/init").default(args.base);
			} catch (e) {
				if (e instanceof Error && e.message === "canceled") {
					process.exit(1);
				}
				throw e;
			}
			process.exit(0);
		}

		const basePath = resolvePath(cwd, args.base as string);

		let secrets = {};
		try {
			secrets = await readJSON(resolvePath(basePath, "secrets.json"));
		} catch (e) {
			/* tslint:disable no-empty */
		}
		const publicPath = resolvePath(basePath, "public");
		const mobius = await prepare({
			sourcePath: basePath,
			publicPath,
			secrets,
			minify: args.minify as boolean,
			sourceMaps: args["source-map"] as boolean,
			hostname: args.hostname as string | undefined,
			workers: args.workers as number,
			simulatedLatency: args["simulated-latency"] as number,
			bundled: args.bundled as boolean,
			generate: args.generate as boolean,
		});

		const expressAsync = require("express") as typeof express;
		const server = expressAsync();

		server.disable("x-powered-by");
		server.disable("etag");

		mobius.install(server);

		server.use(expressAsync.static(publicPath));

		const port = args.port;
		const hostname = args.hostname;
		const acceptSocket = server.listen(port, () => {
			const publicURL = typeof hostname == "string" ? "http://" + hostname : "http://localhost:" + port;
			console.log(`Serving ${basePath} on ${publicURL}`);
			if (args.launch as boolean) {
				(require("opn") as (url: string) => void)(publicURL);
			}
		});

		// Graceful shutdown
		process.on("SIGTERM", onInterrupted);
		process.on("SIGINT", onInterrupted);
		async function onInterrupted() {
			process.removeListener("SIGTERM", onInterrupted);
			process.removeListener("SIGINT", onInterrupted);
			const acceptSocketClosed = new Promise((resolve) => {
				acceptSocket.close(resolve);
			});
			await mobius.stop();
			await acceptSocketClosed;
			process.exit(0);
		}

		server.get("/term", async (request, response) => {
			response.send("exiting");
			const acceptSocketClosed = new Promise((resolve) => {
				acceptSocket.close(resolve);
			});
			await mobius.stop();
			await acceptSocketClosed;
		});

	})().catch(escape);
}

if (require.main === module) {
	main();
}
