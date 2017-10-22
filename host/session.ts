import { PageRenderer } from "./page-renderer";
import { loadModule, SandboxModule } from "./sandbox";
import { Host } from "./host";
import { Client } from "./client";
import { defer, escape, escaping } from "./event-loop";
import { exists, readFile } from "./fileUtils";

import { JsonValue, Channel } from "mobius-types";

import * as mobiusModule from "mobius";

import { interceptGlobals, FakedGlobals } from "../common/determinism";
import { logOrdering, roundTrip, eventForValue, eventForException, parseValueEvent, disconnectedError, Event } from "../common/_internal";

import { Request } from "express";

import { createWriteStream } from "fs";

const resolvedPromise: Promise<void> = Promise.resolve();

// Lazy version of loadModule so that the sandbox module is loaded on first use
let loadModuleLazy: typeof loadModule = (path, module, globalProperties, require_) => {
	loadModuleLazy = require("./sandbox").loadModule as typeof loadModule;
	return loadModuleLazy(path, module, globalProperties, require_);
}

// Hack so that Module._findPath will find TypeScript files
const Module = require("module");
Module._extensions[".ts"] = Module._extensions[".tsx"] = function() {}

interface MobiusGlobalProperties {
	document: Document,
	request?: Request,
}

export interface ArchivedSession {
	events: (Event | boolean)[];
	channels: number[];
}

const enum ArchiveStatus {
	None = 0,
	Partial = 1,
	Full
};

const bakedModules: { [moduleName: string]: (session: Session) => any } = {
	mobius: (session: Session) => session.mobius,
	request: (session: Session) => session.request,
	setCookie: (session: Session) => session.setCookie.bind(session),
	document: (session: Session) => session.globalProperties.document,
	head: (session: Session) => session.pageRenderer.head,
	body: (session: Session) => session.pageRenderer.body,
	secrets: (session: Session) => session.host.secrets,
};

export class Session {
	host: Host;
	sessionID: string;
	dead: boolean = false;
	// Script context
	modules = new Map<string, SandboxModule>();
	mobius: typeof mobiusModule;
	request?: Request;
	hasRun: boolean = false;
	pageRenderer: PageRenderer;
	globalProperties: MobiusGlobalProperties & FakedGlobals;
	Math: typeof Math;
	clients = new Map<number, Client>();
	currentClientID: number = 0;
	lastMessageTime: number = Date.now();
	// Local channels
	localChannelCounter: number = 0;
	localChannels = new Map<number, (event?: Event) => void>();
	localChannelCount: number = 0;
	dispatchingAPIImplementation: number = 0;
	prerenderChannelCount: number = 0;
	prerenderCompleted?: Promise<void>;
	completePrerender?: () => void;
	// Remote channels
	remoteChannelCounter: number = 0;
	pendingChannels = new Map<number, (event?: Event) => void>();
	pendingChannelCount: number = 0;
	dispatchingEvent: number = 0;
	// Incoming Events
	currentEvents: (Event | boolean)[] | undefined;
	hadOpenServerChannel: boolean = false;
	// Archival
	recentEvents?: (Event | boolean)[];
	archivingEvents?: Promise<void>;
	archiveStatus: ArchiveStatus = ArchiveStatus.None;
	bootstrappingChannels?: Set<number>;
	bootstrappingPromise?: Promise<void>;
	// Session sharing
	sharingEnabled?: true;
	constructor(host: Host, sessionID: string, request?: Request) {
		this.host = host;
		this.sessionID = sessionID;
		this.pageRenderer = new PageRenderer(this.host.dom, this.host.noscript, this.host.metaRedirect);
		// Server-side version of the API
		this.mobius = {
			disconnect: () => this.destroy().catch(escape),
			dead: false,
			createClientPromise: this.createClientPromise,
			createServerPromise: this.createServerPromise,
			createClientChannel: this.createClientChannel,
			createServerChannel: this.createServerChannel,
			coordinateValue: this.coordinateValue,
			synchronize: () => this.createServerPromise(() => undefined),
			flush: async () => {
				if (this.dead) {
					throw disconnectedError();
				}
				this.scheduleSynchronize();
				return resolvedPromise;
			},
			shareSession: this.shareSession
		};
		this.request = request;
		const globalProperties: MobiusGlobalProperties & Partial<FakedGlobals> = {
			document: this.host.document,
			request: this.request
		};
		this.globalProperties = interceptGlobals(globalProperties, () => this.insideCallback, this.coordinateValue, this.createServerChannel);
		if (this.host.allowMultipleClientsPerSession) {
			this.recentEvents = [];
		}
	}

	newClient(request: Request) {
		const newClientId = this.currentClientID++;
		if (this.sharingEnabled || (newClientId == 0)) {
			const result = new Client(this, request, newClientId);
			this.request = request;
			this.clients.set(newClientId, result);
			return result;
		}
		throw new Error("Multiple clients attached to the same session are not supported!");
	}

	hasCapableClient() {
		for (const client of this.clients) {
			if (client[1].clientIsActive) {
				return true;
			}
		}
		return false;
	}

	loadModule(path: string, newModule: SandboxModule, allowNodeModules: boolean) {
		loadModuleLazy(path, newModule, this.globalProperties, (name: string) => {
			const bakedModule = bakedModules[name];
			if (bakedModule) {
				return bakedModule(this);
			}
			const modulePath = Module._findPath(name, newModule.paths, false);
			if (modulePath) {
				const existingModule = this.modules.get(modulePath);
				if (existingModule) {
					return existingModule.exports;
				}
				const subModule: SandboxModule = {
					exports: {},
					paths: newModule.paths
				};
				this.modules.set(modulePath, subModule);
				this.loadModule(modulePath, subModule, !!Module._findPath(name, this.host.serverModulePaths));
				return subModule.exports;
			}
			const result = require(name);
			if (!allowNodeModules) {
				var e = new Error(`Cannot access module '${name}' in this context`);
				(e as any).code = "MODULE_NOT_FOUND";
				throw e;
			}
			return result;
		});
		return newModule;
	}

	// Async so that errors inside user code startup will log to console as unhandled promise rejection, but app will proceed
	async run() {
		if (!this.hasRun) {
			this.hasRun = true;
			this.enteringCallback();
			this.loadModule(this.host.scriptPath, {
				exports: {},
				paths: this.host.modulePaths
			}, false);
		}
	}

	sendEvent(event: Event) {
		if (this.recentEvents) {
			this.recentEvents.push(event);
		}
		for (const client of this.clients.values()) {
			client.sendEvent(event);
		}
	}

	dispatchClientEvent(event: Event) {
		let channelId = event[0];
		if (channelId < 0) {
			// Server decided the ordering on "fenced" events
			this.sendEvent(event);
			channelId = -channelId;
		} else {
			// Record the event ordering, but don't send to client as they've already processed it
			event[0] = -channelId;
			if (this.recentEvents) {
				this.recentEvents.push(event);
			}
		}
		const channel = this.pendingChannels.get(channelId);
		if (channel) {
			logOrdering("client", "message", channelId, this.sessionID);
			channel(event.slice() as Event);
		} else {
			// Client-side event source was destroyed on the server between the time it generated an event and the time the server received it
			// This event will be silently dropped--dispatching would cause split brain!
		}
	}

	updateOpenServerChannelStatus(newValue: boolean) {
		if (this.hadOpenServerChannel != newValue) {
			this.hadOpenServerChannel = newValue;
			if (this.recentEvents) {
				this.recentEvents.push(newValue);
			}
		}
	}

	async processEvents(events: Event[], noJavaScript?: boolean) : Promise<void> {
		// Read each event and dispatch the appropriate event in order
		this.updateOpenServerChannelStatus(noJavaScript ? true : (this.localChannelCount != 0));
		this.currentEvents = events;
		this.run();
		for (let event of events) {
			this.dispatchClientEvent(event);
			await defer();
		}
		this.updateOpenServerChannelStatus(this.localChannelCount != 0);
		this.currentEvents = undefined;
	}

	scheduleSynchronize() {
		for (const client of this.clients.values()) {
			client.scheduleSynchronize();
		}
	}

	enterLocalChannel(delayPrerender: boolean = true) : number {
		if (delayPrerender) {
			++this.prerenderChannelCount;
		}
		return ++this.localChannelCount;
	}
	exitLocalChannel(resumePrerender: boolean = true) : number {
		if (resumePrerender) {
			if (--this.prerenderChannelCount == 0) {
				defer().then(() => {
					if (this.completePrerender) {
						this.completePrerender();
						delete this.completePrerender;
						delete this.prerenderCompleted;
					}
				});
			}
		}
		return --this.localChannelCount;
	}
	prerenderContent() : Promise<void> {
		if (this.prerenderCompleted) {
			return this.prerenderCompleted;
		}
		this.enterLocalChannel();
		this.run();
		defer().then(() => this.exitLocalChannel());
		return this.prerenderCompleted = new Promise<void>(resolve => {
			this.completePrerender = resolve;
		});
	}
	shouldImplementLocalChannel(channelId: number) : boolean {
		return !this.bootstrappingChannels || this.bootstrappingChannels.has(channelId);
	}

	get insideCallback() {
		return this.dispatchingEvent != 0 && this.dispatchingAPIImplementation == 0;
	}
	async enteringCallback() {
		this.dispatchingEvent++;
		await defer();
		this.dispatchingEvent--;
	}
	createServerPromise = <T extends JsonValue | void>(ask: () => (Promise<T> | T), includedInPrerender: boolean = true) => {
		if (!this.insideCallback) {
			return new Promise<T>(resolve => resolve(ask()));
		}
		// Record and ship values/errors of server-side promises
		let channelId = ++this.localChannelCounter;
		const exit = escaping(() => {
			if (channelId != -1) {
				this.localChannels.delete(channelId);
				channelId = -1;
				this.exitLocalChannel(includedInPrerender);
			}
		});
		return new Promise<T>((resolve, reject) => {
			logOrdering("server", "open", channelId, this.sessionID);
			this.enterLocalChannel(includedInPrerender);
			this.localChannels.set(channelId, (event?: Event) => {
				if (channelId >= 0) {
					if (event) {
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						resolvedPromise.then(exit);
						this.enteringCallback();
						parseValueEvent(global, event, resolve as (value: JsonValue) => void, reject);
					} else {
						logOrdering("server", "close", channelId, this.sessionID);
						exit();
					}
				}
			});
			if (!this.shouldImplementLocalChannel(channelId)) {
				return;
			}
			this.dispatchingAPIImplementation++;
			let result = new Promise<T>(resolve => resolve(ask()));
			this.dispatchingAPIImplementation--;
			result.then(async value => {
				const event = eventForValue(channelId, value);
				if (this.currentEvents) {
					if (this.bootstrappingPromise) {
						await this.bootstrappingPromise;
					}
					await defer();
				}
				if (channelId >= 0) {
					try {
						this.updateOpenServerChannelStatus(true);
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						this.sendEvent(event);
					} catch (e) {
						escape(e);
					}
					resolvedPromise.then(exit);
					const roundtripped = roundTrip(value);
					this.enteringCallback();
					resolve(roundtripped);
				}
			}).catch(async error => {
				if (this.currentEvents) {
					if (this.bootstrappingPromise) {
						await this.bootstrappingPromise;
					}
					await defer();
				}
				if (channelId >= 0) {
					try {
						this.updateOpenServerChannelStatus(true);
						logOrdering("server", "message", channelId, this.sessionID);
						logOrdering("server", "close", channelId, this.sessionID);
						this.sendEvent(eventForException(channelId, error));
					} catch (e) {
						escape(e);
					}
					resolvedPromise.then(exit);
					this.enteringCallback();
					reject(error);
				}
			});
		});
	}
	createServerChannel = <T extends Function, U>(callback: T, onOpen: (send: T) => U, onClose?: (state: U) => void, includedInPrerender: boolean = true) => {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		let state: U | undefined;
		if (!this.insideCallback) {
			// Not coordinating
			let open = true;
			try {
				const potentialState = onOpen(function() {
					if (open) {
						callback.apply(null, arguments);
					}
				} as any as T);
				if (onClose) {
					state = potentialState;
				}
			} catch (e) {
				onClose = undefined;
				escape(e);
			}
			return {
				channelId: -1,
				close() {
					if (open) {
						open = false;
						if (onClose) {
							session.dispatchingAPIImplementation++;
							escaping(onClose)(state as U);
							session.dispatchingAPIImplementation--;
						}
					}
				}
			};
		}
		// Record and ship arguments of server-side events
		const session = this;
		let channelId = ++session.localChannelCounter;
		logOrdering("server", "open", channelId, this.sessionID);
		session.enterLocalChannel(includedInPrerender);
		const close = () => {
			if (channelId >= 0) {
				logOrdering("server", "close", channelId, session.sessionID);
				session.localChannels.delete(channelId);
				channelId = -1;
				resolvedPromise.then(escaping(() => {
					if (session.exitLocalChannel(includedInPrerender) == 0) {
						// If this was the last server channel, reevaluate queued events so the session can be potentially collected
						session.scheduleSynchronize();
					}
				}));
				if (onClose) {
					session.dispatchingAPIImplementation++;
					escaping(onClose)(state as U);
					session.dispatchingAPIImplementation--;
				}
			}
		};
		session.localChannels.set(channelId, (event?: Event) => {
			if (event) {
				logOrdering("server", "message", channelId, this.sessionID);
				session.enteringCallback();
				(callback as any as Function).apply(null, roundTrip(event.slice(1)));
			} else {
				close();
			}
		});
		if (this.shouldImplementLocalChannel(channelId)) {
			try {
				this.dispatchingAPIImplementation++;
				const potentialState = onOpen(function() {
					if (channelId >= 0) {
						let args = roundTrip([...arguments]);
						(async () => {
							if (session.currentEvents) {
								if (session.bootstrappingPromise) {
									await session.bootstrappingPromise;
								}
								await defer();
							}
							try {
								session.updateOpenServerChannelStatus(true);
								session.sendEvent([channelId, ...roundTrip(args)] as Event);
							} catch (e) {
								escape(e);
							}
							logOrdering("server", "message", channelId, session.sessionID);
							session.enteringCallback();
							(callback as any as Function).apply(null, args);
						})();
					}
				} as any as T);
				if (onClose) {
					state = potentialState;
				}
				this.dispatchingAPIImplementation--;
			} catch (e) {
				this.dispatchingAPIImplementation--;
				onClose = undefined;
				escape(e);
			}
		} else {
			onClose = undefined;
		}
		return {
			channelId,
			close
		};
	}

	createRawClientChannel(callback: (event: Event | undefined) => void) : Channel {
		const session = this;
		session.pendingChannelCount++;
		let channelId = ++session.remoteChannelCounter;
		logOrdering("client", "open", channelId, this.sessionID);
		this.pendingChannels.set(channelId, callback);
		return {
			channelId,
			close() {
				if (channelId != -1) {
					logOrdering("client", "close", channelId, session.sessionID);
					session.pendingChannels.delete(channelId);
					channelId = -1;
					if ((--session.pendingChannelCount) == 0) {
						// If this was the last client channel, reevaluate queued events so the session can be potentially collected
						session.scheduleSynchronize();
					}
				}
			}
		};
	}
	createClientPromise = <T extends JsonValue | void>(fallback?: () => Promise<T> | T) => {
		return new Promise<T>((resolve, reject) => {
			if (!this.insideCallback) {
				return reject(new Error("Unable to create client promise in this context!"));
			}
			if (this.dead) {
				if (fallback) {
					return resolve(fallback());
				}
				return reject(disconnectedError());
			}
			const channel = this.createRawClientChannel(event => {
				this.enteringCallback();
				channel.close();
				if (event) {
					parseValueEvent(global, event, resolve as (value: JsonValue | void) => void, reject);
				} else {
					reject(disconnectedError());
				}
			});
			if (!this.hasCapableClient() && !this.bootstrappingPromise) {
				this.enterLocalChannel(true);
				this.dispatchingAPIImplementation++;
				const promise = fallback ? new Promise<T>(resolve => resolve(fallback())) : Promise.reject(new Error("Browser does not support client-side rendering!"))
				this.dispatchingAPIImplementation--;
				promise.then(async value => {
					if (this.currentEvents) {
						await defer();
					}
					this.dispatchClientEvent(eventForValue(-channel.channelId, value));
				}).catch(async error => {
					if (this.currentEvents) {
						await defer();
					}
					this.dispatchClientEvent(eventForException(-channel.channelId, error));
				}).then(() => this.exitLocalChannel());
			}
		});
	}
	createClientChannel = <T extends Function>(callback: T) => {
		if (!("call" in callback)) {
			throw new TypeError("callback is not a function!");
		}
		if (!this.insideCallback) {
			throw new Error("Unable to create client channel in this context!");
		}
		const channel = this.createRawClientChannel(event => {
			if (event) {
				event.shift();
				this.enteringCallback();
				resolvedPromise.then(() => callback.apply(null, event));
			} else {
				channel.close();
			}
		});
		return channel;
	}

	findValueEvent(channelId: number) : Event | undefined {
		let events = this.currentEvents;
		if (events) {
			// Events are represented differently inside currentEvents depending on whether we're processing a client message or unarchiving
			// Makes more sense to handle the special case here than to transform the array just for this one case
			if (!this.bootstrappingChannels) {
				if (channelId >= 0) {
					return;
				}
				channelId = -channelId;
			}
			for (let event of events as Event[]) {
				if (event[0] == channelId) {
					return event;
				}
			}
		}
	}

	coordinateValue = <T extends JsonValue>(generator: () => T) => {
		if (!this.insideCallback) {
			return generator();
		}
		let value: T;
		if (!this.hadOpenServerChannel) {
			let channelId = ++this.remoteChannelCounter;
			logOrdering("client", "open", channelId, this.sessionID);
			// Peek at incoming events to find the value generated on the client
			const event = this.findValueEvent(-channelId);
			if (event) {
				logOrdering("client", "message", channelId, this.sessionID);
				logOrdering("client", "close", channelId, this.sessionID);
				return parseValueEvent(global, event, value => value, error => {
					throw error;
				}) as T;
			}
			console.log("Expected a value from the client, but didn't receive one which may result in split-brain!\nCall stack is " + (new Error() as any).stack.split(/\n\s*/g).slice(2).join("\n\t"));
			value = generator();
			logOrdering("client", "message", channelId, this.sessionID);
			logOrdering("client", "close", channelId, this.sessionID);
		} else {
			let channelId = ++this.localChannelCounter;
			logOrdering("server", "open", channelId, this.sessionID);
			const event = this.findValueEvent(channelId);
			if (event) {
				logOrdering("server", "message", channelId, this.sessionID);
				logOrdering("server", "close", channelId, this.sessionID);
				this.sendEvent(event);
				return parseValueEvent(global, event, value => value, error => {
					throw error;
				}) as T;
			}
			try {
				value = generator();
				const event = eventForValue(channelId, value);
				try {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendEvent(event);
				} catch(e) {
					escape(e);
				}
			} catch(e) {
				try {
					logOrdering("server", "message", channelId, this.sessionID);
					logOrdering("server", "close", channelId, this.sessionID);
					this.sendEvent(eventForException(channelId, e));
				} catch(e) {
					escape(e);
				}
				throw e;
			}
		}
		return roundTrip(value) as T;
	}

	shareSession = async () => {
		// Server promise so that client can confirm that sharing is enabled
		const server = this.createServerPromise(async () => {
			if (!this.host.allowMultipleClientsPerSession) {
				throw new Error("Sharing has been disabled!");
			}
			this.sharingEnabled = true;
			const request = this.request;
			if (request) {
				return `${request.protocol}://${this.host.hostname || request.get("host")}${request.url.replace(/(\.websocket)?\?.*$/, "")}?sessionID=${this.sessionID}`;
			}
			throw new Error("Session does not have a request to load sharing URL from!");
		});
		const result = await server;
		// Dummy channel that stays open
		this.createServerChannel(emptyFunction, emptyFunction, undefined, false);
		return result;
	}

	setCookie(key: string, value: string) {
		for (const client of this.clients.values()) {
			client.setCookie(key, value);
		}
	}

	async destroy() {
		if (!this.dead) {
			this.dead = true;
			this.mobius.dead = true;
			await this.archiveEvents(true);
			// await unlink(this.host.pathForSessionId(this.sessionID));
			for (const pair of this.pendingChannels) {
				pair[1]();
			}
			this.pendingChannels.clear();
			for (const pair of this.localChannels) {
				pair[1]();
			}
			this.localChannels.clear();
			for (const client of this.clients.values()) {
				await client.destroy();
			}
			this.host.sessions.delete(this.sessionID);
		}
	}

	async destroyIfExhausted() {
		// If no channels remain, the session is in a state where no more events
		// can be sent from either the client or server. Session can be destroyed
		if (this.pendingChannelCount + this.localChannelCount == 0) {
			await this.destroy();
		}
	}

	async archiveEvents(includeTrailer: boolean) : Promise<void> {
		// Can only archive if we're recording events
		if (!this.recentEvents || (!this.recentEvents.length && !includeTrailer)) {
			return;
		}
		// Only one archiver can run at a time
		while (this.archivingEvents) {
			await this.archivingEvents;
		}
		const recentEvents = this.recentEvents;
		if (recentEvents) {
			this.recentEvents = [];
		}
		// Actually archive
		await (this.archivingEvents = (async () => {
			// Determine where to write and whether or not this is a fresh session
			const path = this.host.pathForSessionId(this.sessionID);
			const freshFile = this.archiveStatus != ArchiveStatus.Partial || !(await exists(path));
			// Prepare events
			let unarchivedEvents: (Event | boolean)[] | undefined;
			if (this.archiveStatus == ArchiveStatus.Full) {
				try {
					unarchivedEvents = (await Session.readArchivedSession(this.host.pathForSessionId(this.sessionID))).events;
				} catch (e) {
				}
			}
			const events = unarchivedEvents ? unarchivedEvents.concat(recentEvents || []) : (recentEvents || []);
			const serializedEvents = JSON.stringify(events);
			// Attempt to write as stream
			const stream = createWriteStream(path, { flags: freshFile ? "w" : "a" });
			if (freshFile) {
				stream.write("{\"events\":");
				stream.write(serializedEvents.substring(0, serializedEvents.length - 1));
			} else if (events.length) {
				stream.write(",");
				stream.write(serializedEvents.substring(1, serializedEvents.length - 1));
			}
			// Include full trailer if required
			if (includeTrailer) {
				stream.write("],\"channels\":" + JSON.stringify(Array.from(this.localChannels.keys())) + "}");
			}
			stream.end();
			return stream;
		})().then(stream => new Promise<void>(resolve => {
			const finished = () => {
				this.archiveStatus = includeTrailer ? ArchiveStatus.Full : ArchiveStatus.Partial;
				delete this.archivingEvents;
				resolve();
			};
			stream.on("finish", finished);
			stream.on("error", () => {
				// Failed to write, put the events back
				this.recentEvents = recentEvents.concat(this.recentEvents || []);
				finished();
			});
		})));
	}

	static async readArchivedSession(path: string) : Promise<Partial<ArchivedSession>> {
		const rawContents = (await readFile(path)).toString();
		const validJSONContents = rawContents[rawContents.length - 1] == "}" ? rawContents : rawContents + "]}";
		return JSON.parse(validJSONContents) as Partial<ArchivedSession>;
	}

	async readAllEvents() : Promise<(Event | boolean)[] | undefined> {
		if (this.archiveStatus == ArchiveStatus.None) {
			return this.recentEvents;
		}
		let archivedEvents: (Event | boolean)[] | undefined;
		do {
			if (this.archivingEvents) {
				await this.archivingEvents;
			}
			archivedEvents = (await Session.readArchivedSession(this.host.pathForSessionId(this.sessionID))).events;
		} while (this.archivingEvents);
		const recentEvents = this.recentEvents;
		if (!recentEvents) {
			return undefined;
		}
		return archivedEvents ? archivedEvents.concat(recentEvents) : recentEvents;
	}

	async restoreFromArchive(archive: ArchivedSession) : Promise<void> {
		this.bootstrappingChannels = new Set<number>(archive.channels);
		let completedBootstrapping: () => void;
		this.bootstrappingPromise = new Promise<void>(resolve => completedBootstrapping = resolve);
		// Read each event and dispatch the appropriate event in order
		const events = archive.events;
		this.currentEvents = events;
		const firstEvent = events[0];
		if (typeof firstEvent == "boolean") {
			this.updateOpenServerChannelStatus(firstEvent);
		}
		this.run();
		for (let event of events) {
			if (typeof event == "boolean") {
				this.updateOpenServerChannelStatus(event);
				continue;
			}
			const channelId = event[0];
			if (channelId < 0) {
				this.dispatchClientEvent(event);
			} else {
				if (this.recentEvents) {
					this.recentEvents.push(event);
				}
				const callback = this.localChannels.get(channelId);
				if (callback) {
					logOrdering("server", "message", channelId, this.sessionID);
					callback(event);
				}
			}
			await defer();
		}
		this.currentEvents = undefined;
		this.recentEvents = archive.events;
		this.bootstrappingChannels = undefined;
		this.bootstrappingPromise = undefined;
		completedBootstrapping!();
	}
};

function emptyFunction() {
}
