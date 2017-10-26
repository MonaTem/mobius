#!/usr/bin/env node
import { createHash } from "crypto";
import { cpus } from "os";
import { resolve as resolvePath } from "path";
import * as util from "util";
const Module = require("module");

import * as bodyParser from "body-parser";
import * as express from "express";

import { diff_match_patch } from "diff-match-patch";
const diffMatchPatchNode = new (require("diff-match-patch-node") as typeof diff_match_patch)();

import { Client } from "./host/client";
import clientCompile from "./host/client-compiler";
import * as csrf from "./host/csrf";
import { escape } from "./host/event-loop";
import { exists, mkdir, packageRelative, readFile, readJSON, rimraf, stat, unlink, writeFile } from "./host/fileUtils";
import { Host } from "./host/host";
import { PageRenderMode } from "./host/page-renderer";
import { Session } from "./host/session";

import { ClientMessage, deserializeMessageFromText, serializeMessageAsText } from "./common/_internal";

import * as commandLineArgs from "command-line-args";

function delay(amount: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, amount));
}

function noCache(response: express.Response) {
	response.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
	response.header("Expires", new Date(0).toUTCString());
	response.header("Pragma", "no-cache");
}

function topFrameHTML(response: express.Response, html: string) {
	// Return HTML
	noCache(response);
	response.set("Content-Security-Policy", "frame-ancestors 'none'");
	response.set("Content-Type", "text/html; charset=utf-8");
	response.send(html);
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
}

function defaultSessionPath(sourcePath: string) {
	return resolvePath(sourcePath, ".sessions");
}

export async function prepare({ sourcePath, publicPath, sessionsPath = defaultSessionPath(sourcePath), secrets, allowMultipleClientsPerSession = true, minify = false, sourceMaps, workers = cpus().length, hostname, simulatedLatency = 0 }: Config) {
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
	const host = new Host(serverJSPath, serverModulePaths, modulePaths, sessionsPath, publicPath, (await htmlContents).toString(), secrets, allowMultipleClientsPerSession, workers, hostname);

	// Read fallback script
	const fallbackPath = packageRelative("dist/fallback.js");
	const fallbackContentsAsync = readFile(fallbackPath);

	// Start initial page render
	const initialPageSession = host.constructSession("initial-render");
	host.sessions.set("initial-render", initialPageSession);
	initialPageSession.updateOpenServerChannelStatus(true);
	const prerender = initialPageSession.prerenderContent();

	// Compile client code while userspace is running
	const asyncClientScript = clientCompile(serverJSPath, sourcePath, publicPath, minify);
	const clientScript = await asyncClientScript;
	const clientScriptBuffer = Buffer.from(clientScript.code);
	const clientHash = createHash("sha256").update(clientScriptBuffer).digest("base64");
	const clientURL = "/client-" + clientHash.replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "").substring(0, 16) + ".js";
	const clientIntegrity = "sha256-" + clientHash;
	const fallbackContents = await fallbackContentsAsync;
	const fallbackIntegrity = "sha256-" + createHash("sha256").update(fallbackContents).digest("base64");

	// Finish prerender of initial page
	await prerender;
	const defaultRenderedHTML = await initialPageSession.render({
		mode: PageRenderMode.Bare,
		client: { clientID: 0, incomingMessageId: 0 },
		clientURL,
		clientIntegrity,
		fallbackIntegrity,
		noScriptURL: "/?js=no",
		cssBasePath: publicPath
	});
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
							return topFrameHTML(response, defaultRenderedHTML);
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
						clientURL,
						clientIntegrity,
						fallbackIntegrity,
						bootstrap: true,
						cssBasePath: publicPath
					});
					client.incomingMessageId++;
					client.applyCookies(response);
					if (simulatedLatency) {
						await delay(simulatedLatency);
					}
					return topFrameHTML(response, html);
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
							clientURL,
							clientIntegrity,
							fallbackIntegrity
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

			server.get("/fallback.js", async (request: express.Request, response: express.Response) => {
				if (simulatedLatency) {
					await delay(simulatedLatency);
				}
				response.set("Content-Type", "text/javascript; charset=utf-8");
				response.set("Cache-Control", "no-transform");
				response.send(fallbackContents);
			});
			server.get("/client.js", async (request: express.Request, response: express.Response) => {
				if (simulatedLatency) {
					await delay(simulatedLatency);
				}
				response.set("Content-Type", "text/javascript; charset=utf-8");
				response.set("Cache-Control", "no-transform");
				if (sourceMaps) {
					response.set("SourceMap", "/client.js.map");
				}
				response.send(clientScriptBuffer);
			});
			server.get(clientURL, async (request: express.Request, response: express.Response) => {
				if (simulatedLatency) {
					await delay(simulatedLatency);
				}
				response.set("Content-Type", "text/javascript; charset=utf-8");
				response.set("Cache-Control", "max-age=31536000, no-transform");
				response.set("Expires", "Sun, 17 Jan 2038 19:14:07 GMT");
				if (sourceMaps) {
					response.set("SourceMap", "/client.js.map");
				}
				response.send(clientScriptBuffer);
			});
			if (sourceMaps) {
				server.get("/client.js.map", async (request: express.Request, response: express.Response) => {
					response.set("Content-Type", "application/json; charset=utf-8");
					response.set("Cache-Control", "no-transform");
					response.send(clientScript.map);
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
			{ name: "hostname", type: String },
			{ name: "simulated-latency", type: Number, defaultValue: 0 },
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
							name: "workers",
							typeLabel: "[underline]{number}",
							description: `Number or workers to use (defaults to number of CPUs: ${cpuCount})`,
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
